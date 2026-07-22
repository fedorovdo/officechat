import unittest
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch
from uuid import uuid4

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
