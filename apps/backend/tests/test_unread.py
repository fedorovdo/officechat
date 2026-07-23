import asyncio
import unittest
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch
from uuid import uuid4

from sqlalchemy.dialects import postgresql

from app.schemas.unread import MarkReadRequest, UnreadSummaryPublic
from app.services import unread

NOW = datetime.now(timezone.utc)


class ScalarResult:
    def __init__(self, value):
        self.value = value

    def scalar_one_or_none(self):
        return self.value


class StateSession:
    def __init__(self, state):
        self.state = state
        self.commits = 0

    async def execute(self, statement):
        return ScalarResult(self.state)

    async def commit(self):
        self.commits += 1

    async def refresh(self, value):
        return None


class InitSession:
    def __init__(self):
        self.statements = []
        self.commits = 0

    async def execute(self, statement):
        self.statements.append(statement)
        return SimpleNamespace(all=lambda: [])

    async def commit(self):
        self.commits += 1


class ReturningSession:
    def __init__(self, ids):
        self.ids = ids
        self.statement = None

    async def execute(self, statement):
        self.statement = statement
        return SimpleNamespace(scalars=lambda: SimpleNamespace(all=lambda: self.ids))


class GroupMessageSession:
    def __init__(self, group, message):
        self.group = group
        self.message = message

    async def get(self, model, object_id):
        return self.group

    async def execute(self, statement):
        return ScalarResult(self.message)


class BulkRepairSession:
    def __init__(self, notification_ids=None, event_log=None, fail_commit=False):
        self.notification_ids = list(notification_ids or [])
        self.event_log = event_log if event_log is not None else []
        self.fail_commit = fail_commit
        self.statements = []
        self.commits = 0

    async def execute(self, statement):
        self.statements.append(statement)
        if statement.is_update:
            return SimpleNamespace(rowcount=len(self.notification_ids))
        return SimpleNamespace()

    async def commit(self):
        if self.fail_commit:
            self.event_log.append("commit_failed")
            raise RuntimeError("commit failed")
        self.commits += 1
        self.event_log.append("commit")


class ConcurrentRepairSession(BulkRepairSession):
    def __init__(self, row_lock, shared_state):
        super().__init__()
        self.row_lock = row_lock
        self.shared_state = shared_state
        self.has_row_lock = False

    async def execute(self, statement):
        if statement.is_select and statement._for_update_arg is not None:
            await self.row_lock.acquire()
            self.has_row_lock = True
        return await super().execute(statement)

    async def commit(self):
        self.shared_state["completed"] += 1
        await super().commit()
        if self.has_row_lock:
            self.has_row_lock = False
            self.row_lock.release()


class UnreadSummaryTests(unittest.IsolatedAsyncioTestCase):
    async def test_summary_aggregates_three_categories_and_mentions(self):
        user = SimpleNamespace(id=uuid4(), role="user")
        group_id, direct_id, discussion_id = uuid4(), uuid4(), uuid4()
        accessible = {"group": {group_id}, "direct": {direct_id}, "discussion": {discussion_id}}
        rows = {
            "group": [(group_id, uuid4(), NOW, True), (group_id, uuid4(), NOW, False)],
            "direct": [(direct_id, uuid4(), NOW, False)],
            "discussion": [(discussion_id, uuid4(), NOW, False)],
        }

        async def unread_rows(session, current_user, chat_type, chat_ids):
            return rows[chat_type]

        with (
            patch("app.services.unread.accessible_chat_ids", AsyncMock(return_value=accessible)),
            patch("app.services.unread.initialize_missing_read_states", AsyncMock(return_value=False)),
            patch("app.services.unread._unread_rows", side_effect=unread_rows) as rows_mock,
        ):
            result = await unread.get_unread_summary(AsyncMock(), user)

        self.assertEqual(result.total, 4)
        self.assertEqual((result.groups, result.direct, result.discussions), (2, 1, 1))
        self.assertEqual(next(chat for chat in result.chats if chat.chat_type == "group").mention_count, 1)
        self.assertEqual(rows_mock.await_count, 3)

    async def test_missing_state_initializes_at_latest_existing_message(self):
        user = SimpleNamespace(id=uuid4())
        group_id, message_id = uuid4(), uuid4()
        session = InitSession()
        accessible = {"group": {group_id}, "direct": set(), "discussion": set()}
        with patch(
            "app.services.unread._latest_messages_for_chats",
            AsyncMock(side_effect=[{group_id: (message_id, NOW)}, {}, {}]),
        ):
            created = await unread.initialize_missing_read_states(session, user, accessible)

        self.assertTrue(created)
        self.assertEqual(len(session.statements), 2)
        self.assertIn(message_id, session.statements[-1].compile().params.values())
        self.assertEqual(session.commits, 1)


class MarkReadTests(unittest.IsolatedAsyncioTestCase):
    async def test_group_bot_message_uses_normal_group_authorization_and_can_be_marked_read(self):
        group_id, message_id = uuid4(), uuid4()
        user = SimpleNamespace(id=uuid4(), role="user")
        group = SimpleNamespace(id=group_id, is_active=True)
        bot_message = SimpleNamespace(
            id=message_id,
            group_id=group_id,
            sender_user_id=uuid4(),
            sender=SimpleNamespace(role="bot", auth_provider="bot"),
            created_at=NOW,
            is_archived=False,
        )
        payload = MarkReadRequest(chat_type="group", chat_id=group_id, message_id=message_id)
        session = GroupMessageSession(group, bot_message)

        with patch(
            "app.services.unread.ensure_group_message_access",
            AsyncMock(),
        ) as ensure_access:
            result = await unread._load_authorized_message(session, user, payload)

        self.assertIs(result, bot_message)
        ensure_access.assert_awaited_once_with(session, group, user)

    async def test_user_without_group_access_cannot_mark_group_message_read(self):
        group_id, message_id = uuid4(), uuid4()
        user = SimpleNamespace(id=uuid4(), role="user")
        group = SimpleNamespace(id=group_id, is_active=True)
        message = SimpleNamespace(id=message_id, group_id=group_id, is_archived=False)
        payload = MarkReadRequest(chat_type="group", chat_id=group_id, message_id=message_id)
        session = GroupMessageSession(group, message)

        with patch(
            "app.services.unread.ensure_group_message_access",
            AsyncMock(side_effect=PermissionError("denied")),
        ):
            with self.assertRaises(PermissionError):
                await unread._load_authorized_message(session, user, payload)

    async def test_notification_batch_only_targets_message_category_in_selected_chat(self):
        user_id, chat_id, message_id, notification_id = uuid4(), uuid4(), uuid4(), uuid4()
        session = ReturningSession([notification_id])
        message = SimpleNamespace(id=message_id, created_at=NOW)

        result = await unread.mark_message_notifications_read_through(
            session, user_id, "group", chat_id, message
        )

        self.assertEqual(result, [notification_id])
        compiled = session.statement.compile()
        values = set(compiled.params.values())
        self.assertIn("messages", values)
        self.assertIn("group", values)
        self.assertIn(chat_id, values)
        self.assertNotIn("calendar", values)

    async def test_marker_never_moves_backwards_and_call_is_idempotent(self):
        current_marker_id = uuid4()
        state = SimpleNamespace(
            last_read_message_id=current_marker_id,
            last_read_message_created_at=NOW,
            last_read_at=NOW,
        )
        session = StateSession(state)
        user = SimpleNamespace(id=uuid4())
        payload = MarkReadRequest(chat_type="group", chat_id=uuid4(), message_id=uuid4())
        older_message = SimpleNamespace(id=payload.message_id, created_at=NOW - timedelta(minutes=1))
        summary = UnreadSummaryPublic(total=0, groups=0, direct=0, discussions=0, chats=[])

        with (
            patch("app.services.unread._load_authorized_message", AsyncMock(return_value=older_message)),
            patch("app.services.unread.mark_message_notifications_read_through", AsyncMock(return_value=[])),
            patch("app.services.unread.notification_unread_count", AsyncMock(return_value=0)),
            patch("app.services.unread.get_unread_summary", AsyncMock(return_value=summary)),
            patch("app.services.unread.user_websocket_manager.broadcast_to_user", AsyncMock()) as broadcast,
            patch("app.services.unread.direct_websocket_manager.broadcast_to_conversation", AsyncMock()) as direct,
        ):
            await unread.mark_chat_read(session, user, payload)
            await unread.mark_chat_read(session, user, payload)

        self.assertEqual(state.last_read_message_id, current_marker_id)
        self.assertEqual(session.commits, 2)
        self.assertEqual(broadcast.await_count, 2)
        direct.assert_not_awaited()

    async def test_direct_read_emits_participant_room_event(self):
        state = SimpleNamespace(
            last_read_message_id=None,
            last_read_message_created_at=None,
            last_read_at=None,
        )
        session = StateSession(state)
        user = SimpleNamespace(id=uuid4())
        payload = MarkReadRequest(chat_type="direct", chat_id=uuid4(), message_id=uuid4())
        message = SimpleNamespace(id=payload.message_id, created_at=NOW)
        summary = UnreadSummaryPublic(total=0, groups=0, direct=0, discussions=0, chats=[])
        with (
            patch("app.services.unread._load_authorized_message", AsyncMock(return_value=message)),
            patch("app.services.unread.mark_message_notifications_read_through", AsyncMock(return_value=[])),
            patch("app.services.unread.notification_unread_count", AsyncMock(return_value=0)),
            patch("app.services.unread.get_unread_summary", AsyncMock(return_value=summary)),
            patch("app.services.unread.user_websocket_manager.broadcast_to_user", AsyncMock()),
            patch("app.services.unread.direct_websocket_manager.broadcast_to_conversation", AsyncMock()) as direct,
        ):
            await unread.mark_chat_read(session, user, payload)

        event = direct.await_args.args[1]
        self.assertEqual(event["type"], "direct.read")
        self.assertEqual(event["reader_user_id"], str(user.id))

    async def test_message_notification_sync_is_batched_and_broadcast(self):
        state = SimpleNamespace(
            last_read_message_id=None,
            last_read_message_created_at=None,
            last_read_at=None,
        )
        session = StateSession(state)
        user = SimpleNamespace(id=uuid4())
        payload = MarkReadRequest(chat_type="discussion", chat_id=uuid4(), message_id=uuid4())
        message = SimpleNamespace(id=payload.message_id, created_at=NOW)
        notification_ids = [uuid4(), uuid4()]
        summary = UnreadSummaryPublic(total=0, groups=0, direct=0, discussions=0, chats=[])
        with (
            patch("app.services.unread._load_authorized_message", AsyncMock(return_value=message)),
            patch(
                "app.services.unread.mark_message_notifications_read_through",
                AsyncMock(return_value=notification_ids),
            ) as mark_notifications,
            patch("app.services.unread.notification_unread_count", AsyncMock(return_value=3)),
            patch("app.services.unread.get_unread_summary", AsyncMock(return_value=summary)),
            patch("app.services.unread.user_websocket_manager.broadcast_to_user", AsyncMock()) as broadcast,
            patch("app.services.unread.direct_websocket_manager.broadcast_to_conversation", AsyncMock()),
        ):
            result = await unread.mark_chat_read(session, user, payload)

        mark_notifications.assert_awaited_once_with(
            session, user.id, "discussion", payload.chat_id, message
        )
        self.assertEqual(result.notification_unread_count, 3)
        self.assertEqual(result.read_notification_ids, notification_ids)
        notification_event = broadcast.await_args_list[1].args[1]
        self.assertEqual(notification_event["type"], "notifications.messages_read")
        self.assertEqual(notification_event["unread_count"], 3)

    async def test_group_read_broadcasts_authoritative_unread_and_message_notification_state(self):
        state = SimpleNamespace(
            last_read_message_id=None,
            last_read_message_created_at=None,
            last_read_at=None,
        )
        session = StateSession(state)
        user = SimpleNamespace(id=uuid4())
        payload = MarkReadRequest(chat_type="group", chat_id=uuid4(), message_id=uuid4())
        message = SimpleNamespace(id=payload.message_id, created_at=NOW)
        notification_id = uuid4()
        summary = UnreadSummaryPublic(total=2, groups=0, direct=2, discussions=0, chats=[])
        with (
            patch("app.services.unread._load_authorized_message", AsyncMock(return_value=message)),
            patch(
                "app.services.unread.mark_message_notifications_read_through",
                AsyncMock(return_value=[notification_id]),
            ),
            patch("app.services.unread.notification_unread_count", AsyncMock(return_value=4)),
            patch("app.services.unread.get_unread_summary", AsyncMock(return_value=summary)),
            patch("app.services.unread.user_websocket_manager.broadcast_to_user", AsyncMock()) as broadcast,
            patch("app.services.unread.direct_websocket_manager.broadcast_to_conversation", AsyncMock()),
        ):
            result = await unread.mark_chat_read(session, user, payload)

        self.assertEqual(result.total_unread, 2)
        self.assertEqual(result.notification_unread_count, 4)
        unread_event = broadcast.await_args_list[0].args[1]
        notification_event = broadcast.await_args_list[1].args[1]
        self.assertEqual(unread_event["type"], "unread.updated")
        self.assertEqual(unread_event["chat_type"], "group")
        self.assertEqual(notification_event["type"], "notifications.messages_read")
        self.assertEqual(notification_event["notification_ids"], [str(notification_id)])

    async def test_unrelated_user_cannot_mark_direct_conversation_read(self):
        user = SimpleNamespace(id=uuid4())
        payload = MarkReadRequest(chat_type="direct", chat_id=uuid4(), message_id=uuid4())
        conversation = SimpleNamespace(id=payload.chat_id)
        with (
            patch("app.services.unread.get_direct_conversation", AsyncMock(return_value=conversation)),
            patch("app.services.unread.ensure_direct_conversation_access", side_effect=PermissionError("denied")),
        ):
            with self.assertRaises(PermissionError):
                await unread._load_authorized_message(AsyncMock(), user, payload)


class UnreadBroadcastTests(unittest.IsolatedAsyncioTestCase):
    async def test_new_message_broadcast_uses_authoritative_recipient_counts(self):
        sender_id, recipient_id = uuid4(), uuid4()
        counts = {
            sender_id: (0, 0, None, None),
            recipient_id: (3, 1, uuid4(), uuid4()),
        }
        with (
            patch("app.services.unread.ensure_recipient_states_before_message", AsyncMock()),
            patch("app.services.unread.chat_unread_counts_for_users", AsyncMock(return_value=counts)),
            patch("app.services.unread.user_websocket_manager.broadcast_to_user", AsyncMock()) as broadcast,
        ):
            await unread.broadcast_unread_for_chat(
                AsyncMock(), "direct", uuid4(), [sender_id, recipient_id], SimpleNamespace()
            )

        events = {call.args[0]: call.args[1] for call in broadcast.await_args_list}
        self.assertEqual(events[sender_id]["unread_count"], 0)
        self.assertEqual(events[recipient_id]["unread_count"], 3)
        self.assertEqual(events[recipient_id]["mention_count"], 1)

    async def test_removed_membership_clears_only_that_users_chat(self):
        user_id, chat_id = uuid4(), uuid4()
        with patch("app.services.unread.user_websocket_manager.broadcast_to_user", AsyncMock()) as broadcast:
            await unread.broadcast_unread_removed(user_id, "discussion", chat_id)
        self.assertEqual(broadcast.await_args.args[0], user_id)
        self.assertTrue(broadcast.await_args.args[1]["removed"])


class LegacyUnreadRepairTests(unittest.IsolatedAsyncioTestCase):
    async def test_repairs_all_accessible_chat_types_and_only_message_notifications(self):
        current_user_id = uuid4()
        other_user_id = uuid4()
        group_id, direct_id, discussion_id, inaccessible_group_id = (
            uuid4(),
            uuid4(),
            uuid4(),
            uuid4(),
        )
        group_message_id, bot_message_id, direct_message_id, discussion_message_id = (
            uuid4(),
            uuid4(),
            uuid4(),
            uuid4(),
        )
        notification_ids = [uuid4(), uuid4()]
        current_user = SimpleNamespace(id=current_user_id, role="user")
        accessible = {
            "group": {group_id},
            "direct": {direct_id},
            "discussion": {discussion_id},
        }
        boundaries = {
            "group": {group_id: (bot_message_id, NOW, 2)},
            "direct": {direct_id: (direct_message_id, NOW, 1)},
            "discussion": {
                discussion_id: (discussion_message_id, NOW, 1)
            },
        }
        summary = UnreadSummaryPublic(
            total=0,
            groups=0,
            direct=0,
            discussions=0,
            chats=[],
        )
        event_log = []
        session = BulkRepairSession(notification_ids, event_log)

        async def load_boundaries(
            session_arg,
            user_arg,
            chat_type,
            chat_ids,
        ):
            self.assertEqual(chat_ids, accessible[chat_type])
            return boundaries[chat_type]

        async def broadcast(user_id, event):
            self.assertEqual(user_id, current_user_id)
            event_log.append(event["type"])

        with (
            patch(
                "app.services.unread.accessible_chat_ids",
                AsyncMock(return_value=accessible),
            ),
            patch(
                "app.services.unread._repair_boundaries_for_chats",
                side_effect=load_boundaries,
            ),
            patch(
                "app.services.unread.get_unread_summary",
                AsyncMock(return_value=summary),
            ),
            patch(
                "app.services.unread.notification_unread_count",
                AsyncMock(return_value=3),
            ),
            patch(
                "app.services.unread.user_websocket_manager.broadcast_to_user",
                side_effect=broadcast,
            ) as broadcast_mock,
        ):
            result = await unread.mark_all_current_read(session, current_user)

        self.assertEqual(result.cleared_messages, 4)
        self.assertEqual(result.cleared_chats, 3)
        self.assertEqual(result.unread.total, 0)
        self.assertEqual(result.notification_unread_count, 3)
        self.assertEqual(result.read_notifications, len(notification_ids))
        self.assertEqual(event_log, [
            "commit",
            "unread.refresh",
            "notifications.messages_read",
        ])
        self.assertEqual(session.commits, 1)

        lock_statement = next(
            statement for statement in session.statements if statement.is_select
        )
        insert_statement = next(
            statement for statement in session.statements if statement.is_insert
        )
        notification_statement = next(
            statement for statement in session.statements if statement.is_update
        )
        self.assertIn("FOR UPDATE", str(lock_statement))
        insert_values = set(insert_statement.compile().params.values())
        self.assertIn(current_user_id, insert_values)
        self.assertNotIn(other_user_id, insert_values)
        self.assertNotIn(inaccessible_group_id, insert_values)
        notification_values = {
            item
            for value in notification_statement.compile().params.values()
            for item in (value if isinstance(value, (list, set, tuple)) else [value])
        }
        self.assertIn(current_user_id, notification_values)
        self.assertIn("messages", notification_values)
        self.assertNotIn("calendar", notification_values)
        self.assertNotIn("system", notification_values)
        self.assertNotIn("announcements", notification_values)
        self.assertNotIn(inaccessible_group_id, notification_values)
        notification_sql = str(notification_statement.compile())
        self.assertIn("notifications.is_dismissed IS false", notification_sql)
        self.assertIn("messages.created_at <", notification_sql)
        self.assertIn("direct_messages.created_at <", notification_sql)
        self.assertIn("discussion_messages.created_at <", notification_sql)
        self.assertIn("last_read_message_created_at", notification_sql)
        self.assertIn("last_read_message_id", notification_sql)
        notification_event = broadcast_mock.call_args_list[-1].args[1]
        self.assertEqual(notification_event["notification_ids"], [])
        self.assertTrue(notification_event["refresh"])

    async def test_repeated_repair_is_idempotent(self):
        user = SimpleNamespace(id=uuid4(), role="user")
        group_id, message_id = uuid4(), uuid4()
        accessible = {
            "group": {group_id},
            "direct": set(),
            "discussion": set(),
        }
        summary = UnreadSummaryPublic(
            total=0,
            groups=0,
            direct=0,
            discussions=0,
            chats=[],
        )
        session = BulkRepairSession()

        group_calls = 0

        async def load_boundaries(session_arg, user_arg, chat_type, chat_ids):
            nonlocal group_calls
            if chat_type != "group":
                return {}
            group_calls += 1
            return {
                group_id: (
                    message_id,
                    NOW,
                    1 if group_calls == 1 else 0,
                )
            }

        with (
            patch(
                "app.services.unread.accessible_chat_ids",
                AsyncMock(return_value=accessible),
            ),
            patch(
                "app.services.unread._repair_boundaries_for_chats",
                side_effect=load_boundaries,
            ),
            patch(
                "app.services.unread.get_unread_summary",
                AsyncMock(return_value=summary),
            ),
            patch(
                "app.services.unread.notification_unread_count",
                AsyncMock(return_value=0),
            ),
            patch(
                "app.services.unread.user_websocket_manager.broadcast_to_user",
                AsyncMock(),
            ),
        ):
            first = await unread.mark_all_current_read(session, user)
            second = await unread.mark_all_current_read(session, user)

        self.assertEqual((first.cleared_messages, first.cleared_chats), (1, 1))
        self.assertEqual((second.cleared_messages, second.cleared_chats), (0, 0))

    async def test_future_message_after_selected_boundary_remains_unread(self):
        user = SimpleNamespace(id=uuid4(), role="user")
        group_id, boundary_message_id, future_message_id = (
            uuid4(),
            uuid4(),
            uuid4(),
        )
        boundary_time = NOW
        future_time = NOW + timedelta(seconds=1)
        accessible = {
            "group": {group_id},
            "direct": set(),
            "discussion": set(),
        }
        future_summary = UnreadSummaryPublic(
            total=1,
            groups=1,
            direct=0,
            discussions=0,
            chats=[
                {
                    "chat_type": "group",
                    "chat_id": group_id,
                    "unread_count": 1,
                    "mention_count": 0,
                    "first_unread_message_id": future_message_id,
                    "newest_unread_message_id": future_message_id,
                }
            ],
        )
        session = BulkRepairSession()

        async def selected_boundary(
            session_arg,
            user_arg,
            chat_type,
            chat_ids,
        ):
            return (
                {group_id: (boundary_message_id, boundary_time, 1)}
                if chat_type == "group"
                else {}
            )

        with (
            patch(
                "app.services.unread.accessible_chat_ids",
                AsyncMock(return_value=accessible),
            ),
            patch(
                "app.services.unread._repair_boundaries_for_chats",
                side_effect=selected_boundary,
            ),
            patch(
                "app.services.unread.get_unread_summary",
                AsyncMock(return_value=future_summary),
            ),
            patch(
                "app.services.unread.notification_unread_count",
                AsyncMock(return_value=0),
            ),
            patch(
                "app.services.unread.user_websocket_manager.broadcast_to_user",
                AsyncMock(),
            ),
        ):
            result = await unread.mark_all_current_read(session, user)

        self.assertEqual(result.cleared_messages, 1)
        self.assertEqual(result.unread.total, 1)
        insert_statement = next(
            statement for statement in session.statements if statement.is_insert
        )
        insert_values = set(insert_statement.compile().params.values())
        self.assertIn(boundary_message_id, insert_values)
        self.assertNotIn(future_message_id, insert_values)
        self.assertNotIn(future_time, insert_values)

    async def test_commit_failure_does_not_broadcast(self):
        user = SimpleNamespace(id=uuid4(), role="user")
        group_id, message_id = uuid4(), uuid4()
        accessible = {
            "group": {group_id},
            "direct": set(),
            "discussion": set(),
        }
        session = BulkRepairSession(fail_commit=True)

        async def boundaries(session_arg, user_arg, chat_type, chat_ids):
            return (
                {group_id: (message_id, NOW, 1)}
                if chat_type == "group"
                else {}
            )

        with (
            patch(
                "app.services.unread.accessible_chat_ids",
                AsyncMock(return_value=accessible),
            ),
            patch(
                "app.services.unread._repair_boundaries_for_chats",
                side_effect=boundaries,
            ),
            patch(
                "app.services.unread.user_websocket_manager.broadcast_to_user",
                AsyncMock(),
            ) as broadcast,
        ):
            with self.assertRaisesRegex(RuntimeError, "commit failed"):
                await unread.mark_all_current_read(session, user)

        broadcast.assert_not_awaited()
        self.assertEqual(session.event_log, ["commit_failed"])

    async def test_concurrent_repairs_serialize_on_read_state_rows(self):
        user = SimpleNamespace(id=uuid4(), role="user")
        group_id, message_id = uuid4(), uuid4()
        accessible = {
            "group": {group_id},
            "direct": set(),
            "discussion": set(),
        }
        summary = UnreadSummaryPublic(
            total=0,
            groups=0,
            direct=0,
            discussions=0,
            chats=[],
        )
        row_lock = asyncio.Lock()
        shared_state = {"completed": 0}
        sessions = [
            ConcurrentRepairSession(row_lock, shared_state),
            ConcurrentRepairSession(row_lock, shared_state),
        ]

        async def boundaries(session_arg, user_arg, chat_type, chat_ids):
            if chat_type != "group":
                return {}
            return {
                group_id: (
                    message_id,
                    NOW,
                    int(shared_state["completed"] == 0),
                )
            }

        with (
            patch(
                "app.services.unread.accessible_chat_ids",
                AsyncMock(return_value=accessible),
            ),
            patch(
                "app.services.unread._repair_boundaries_for_chats",
                side_effect=boundaries,
            ),
            patch(
                "app.services.unread.get_unread_summary",
                AsyncMock(return_value=summary),
            ),
            patch(
                "app.services.unread.notification_unread_count",
                AsyncMock(return_value=0),
            ),
            patch(
                "app.services.unread.user_websocket_manager.broadcast_to_user",
                AsyncMock(),
            ),
        ):
            results = await asyncio.gather(
                *(unread.mark_all_current_read(session, user) for session in sessions)
            )

        self.assertEqual(
            sorted(
                (result.cleared_messages, result.cleared_chats)
                for result in results
            ),
            [(0, 0), (1, 1)],
        )
        self.assertEqual(shared_state["completed"], 2)

    async def test_repair_boundary_query_uses_canonical_order_and_unread_filters(self):
        user = SimpleNamespace(id=uuid4())
        group_id, message_id = uuid4(), uuid4()

        class CaptureSession:
            statement = None

            async def execute(self, statement):
                self.statement = statement
                return SimpleNamespace(
                    all=lambda: [(group_id, message_id, NOW, 2)]
                )

        session = CaptureSession()
        result = await unread._repair_boundaries_for_chats(
            session,
            user,
            "group",
            {group_id},
        )

        self.assertEqual(result, {group_id: (message_id, NOW, 2)})
        sql = str(
            session.statement.compile(dialect=postgresql.dialect())
        )
        self.assertIn("DISTINCT ON (messages.group_id)", sql)
        self.assertIn(
            "ORDER BY messages.group_id, messages.created_at DESC, messages.id DESC",
            sql,
        )
        self.assertIn("messages.sender_user_id !=", sql)
        self.assertIn("messages.is_deleted IS false", sql)
        self.assertIn("messages.is_archived IS false", sql)
        self.assertIn("messages.created_at <", sql)
        self.assertIn("messages.id <=", sql)


class DirectReceiptPrivacyTests(unittest.IsolatedAsyncioTestCase):
    async def test_unrelated_user_cannot_read_direct_receipt(self):
        user = SimpleNamespace(id=uuid4())
        conversation = SimpleNamespace(id=uuid4())
        with (
            patch("app.services.unread.get_direct_conversation", AsyncMock(return_value=conversation)),
            patch("app.services.unread.ensure_direct_conversation_access", side_effect=PermissionError("denied")),
        ):
            with self.assertRaises(PermissionError):
                await unread.get_direct_read_receipt(AsyncMock(), user, conversation.id)


if __name__ == "__main__":
    unittest.main()
