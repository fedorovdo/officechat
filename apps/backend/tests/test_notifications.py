import unittest
from datetime import datetime, timezone
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch
from uuid import uuid4

from app.services.notifications import (
    build_dedupe_key,
    mark_all_notifications_read,
    preferences_allow,
    sanitize_metadata,
    sanitize_preview,
    serialize_notification,
)


class NotificationSession:
    def __init__(self, notifications):
        self.notifications = notifications
        self.commits = 0

    async def execute(self, statement):
        unread = [item for item in self.notifications if not item.is_read]
        return SimpleNamespace(scalars=lambda: SimpleNamespace(all=lambda: unread))

    async def commit(self):
        self.commits += 1


class NotificationServiceTests(unittest.TestCase):
    def test_default_preferences_keep_group_messages_quiet(self):
        preferences = SimpleNamespace(group_messages_enabled=False, mentions_enabled=True, system_enabled=False)

        self.assertFalse(preferences_allow(preferences, "group_message"))
        self.assertTrue(preferences_allow(preferences, "mention"))
        self.assertTrue(preferences_allow(preferences, "system"))

    def test_reaction_dedupe_includes_actor_and_emoji(self):
        recipient = uuid4()
        message = uuid4()
        first_actor = uuid4()
        second_actor = uuid4()

        first = build_dedupe_key(recipient, "reaction", "reaction", message, {"emoji": "👍", "actor_user_id": first_actor})
        duplicate = build_dedupe_key(recipient, "reaction", "reaction", message, {"emoji": "👍", "actor_user_id": first_actor})
        other_actor = build_dedupe_key(recipient, "reaction", "reaction", message, {"emoji": "👍", "actor_user_id": second_actor})

        self.assertEqual(first, duplicate)
        self.assertNotEqual(first, other_actor)

    def test_preview_and_metadata_are_sanitized(self):
        group_id = uuid4()
        self.assertEqual(sanitize_preview(" hello\n\nworld "), "hello world")
        self.assertTrue((sanitize_preview("x" * 220) or "").endswith("..."))
        self.assertEqual(
            sanitize_metadata({"group_id": group_id, "filesystem_path": "/data/uploads/private.txt"}),
            {"group_id": str(group_id)},
        )

    def test_notification_serializer_uses_loaded_scalar_snapshot(self):
        timestamp = datetime(2026, 7, 12, 12, 0, tzinfo=timezone.utc)
        actor_id = uuid4()
        notification = SimpleNamespace(
            id=uuid4(),
            type="calendar_updated",
            category="calendar",
            source_type="calendar_event",
            source_id=str(uuid4()),
            chat_type=None,
            chat_id=None,
            message_id=None,
            actor_user_id=actor_id,
            actor_username="fallback",
            actor_display_name="Fallback",
            actor=SimpleNamespace(username="admin", display_name="Admin", avatar_url="/avatar.png"),
            title_key="notification.calendar_updated",
            body_preview="Planning",
            meta={"calendar_status": "scheduled"},
            is_read=True,
            read_at=timestamp,
            is_dismissed=False,
            dismissed_at=None,
            created_at=timestamp,
            updated_at=timestamp,
        )

        public = serialize_notification(notification)

        self.assertEqual(public.actor.id, actor_id)
        self.assertEqual(public.actor.username, "admin")
        self.assertEqual(public.updated_at, timestamp)


class NotificationMarkAllTests(unittest.IsolatedAsyncioTestCase):
    async def test_global_mark_all_is_idempotent_across_notification_categories(self):
        notifications = [
            SimpleNamespace(category="messages", is_read=False, read_at=None),
            SimpleNamespace(category="calendar", is_read=False, read_at=None),
            SimpleNamespace(category="system", is_read=True, read_at=datetime.now(timezone.utc)),
        ]
        session = NotificationSession(notifications)
        user_id = uuid4()

        with patch(
            "app.services.notifications.safe_broadcast_notification_event",
            AsyncMock(),
        ) as broadcast:
            first = await mark_all_notifications_read(session, user_id)
            second = await mark_all_notifications_read(session, user_id)

        self.assertEqual(first, 2)
        self.assertEqual(second, 0)
        self.assertTrue(all(item.is_read for item in notifications))
        self.assertEqual(session.commits, 2)
        self.assertEqual(broadcast.await_count, 2)
        self.assertEqual(broadcast.await_args_list[0].args[2], {
            "type": "notifications.read_all",
            "category": None,
        })


if __name__ == "__main__":
    unittest.main()
