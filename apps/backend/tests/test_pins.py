import unittest
from datetime import datetime, timezone
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch
from uuid import uuid4

from app.models.pin import PinnedMessage
from app.schemas.pin import PinCreate
from app.services import pins

NOW = datetime.now(timezone.utc)


def user(role="user", **overrides):
    values = {
        "id": uuid4(),
        "username": "dmitrii",
        "display_name": "Dmitrii",
        "role": role,
        "auth_provider": "local",
        "is_active": True,
    }
    values.update(overrides)
    return SimpleNamespace(**values)


def message(**overrides):
    values = {
        "id": uuid4(),
        "sender": user(username="sender", display_name="Sender"),
        "body": "Important message",
        "attachments": [],
        "is_deleted": False,
        "is_archived": False,
        "archived_at": None,
        "created_at": NOW,
    }
    values.update(overrides)
    return SimpleNamespace(**values)


class PinActorTests(unittest.TestCase):
    def test_bots_and_inactive_users_cannot_pin(self):
        with self.assertRaises(PermissionError):
            pins.validate_pin_actor(user("bot", auth_provider="bot"))
        with self.assertRaises(PermissionError):
            pins.validate_pin_actor(user(is_active=False))

    def test_normal_human_actor_is_accepted(self):
        pins.validate_pin_actor(user())


class PinServiceTests(unittest.IsolatedAsyncioTestCase):
    async def test_duplicate_pin_returns_existing_pin_without_creating(self):
        existing = SimpleNamespace(id=uuid4(), message_id=uuid4())
        payload = PinCreate(chat_type="group", chat_id=uuid4(), message_id=existing.message_id)
        with (
            patch("app.services.pins.require_pin_permission", AsyncMock()),
            patch("app.services.pins.ensure_pin_chat_access", AsyncMock()),
            patch("app.services.pins.get_chat_message", AsyncMock(return_value=message(id=existing.message_id))),
            patch("app.services.pins.get_pin_by_message", AsyncMock(return_value=existing)),
        ):
            pin, created = await pins.create_pin(AsyncMock(), payload, user())
        self.assertIs(pin, existing)
        self.assertFalse(created)

    async def test_per_chat_limit_is_enforced(self):
        payload = PinCreate(chat_type="group", chat_id=uuid4(), message_id=uuid4())
        with (
            patch("app.services.pins.require_pin_permission", AsyncMock()),
            patch("app.services.pins.ensure_pin_chat_access", AsyncMock()),
            patch("app.services.pins.get_chat_message", AsyncMock(return_value=message(id=payload.message_id))),
            patch("app.services.pins.get_pin_by_message", AsyncMock(return_value=None)),
            patch("app.services.pins.count_chat_pins", AsyncMock(return_value=20)),
            patch("app.services.pins.settings.pinned_messages_max_per_chat", 20),
        ):
            with self.assertRaises(pins.PinConflictError):
                await pins.create_pin(AsyncMock(), payload, user())

    async def test_annotates_message_pin_metadata(self):
        pin = PinnedMessage(
            id=uuid4(),
            chat_type="group",
            chat_id=uuid4(),
            message_id=uuid4(),
            pinned_by_username="admin",
            pinned_by_display_name="Admin",
            pinned_at=NOW,
        )
        rows = SimpleNamespace(all=lambda: [pin])
        session = AsyncMock()
        session.execute.return_value = SimpleNamespace(scalars=lambda: rows)
        pinned_message = SimpleNamespace(id=pin.message_id)
        other_message = SimpleNamespace(id=uuid4())

        await pins.annotate_messages_with_pins(session, "group", pin.chat_id, [pinned_message, other_message])

        self.assertTrue(pinned_message.is_pinned)
        self.assertEqual(pinned_message.pin_id, pin.id)
        self.assertFalse(other_message.is_pinned)
        self.assertIsNone(other_message.pin_id)

    def test_message_preview_hides_archived_body(self):
        preview = pins.message_preview(message(is_archived=True, body="secret archived text"))
        self.assertEqual(preview.body_preview, "")
        self.assertTrue(preview.is_archived)


if __name__ == "__main__":
    unittest.main()
