import json
import unittest
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch
from uuid import uuid4

from app.api.routes.admin_bots import post_rotate_token
from app.api.routes.admin_users import create_user, patch_user, reset_password
from app.models.audit import AuditEvent
from app.schemas.user import AdminPasswordReset, AdminUserCreate, AdminUserUpdate
from app.services.audit import record_audit_event, sanitize_audit_value


class AuditSession:
    def __init__(self):
        self.events = []
        self.commits = 0

    def add(self, value):
        if isinstance(value, AuditEvent):
            self.events.append(value)

    async def flush(self):
        return None

    async def commit(self):
        self.commits += 1

    async def refresh(self, _value):
        return None


def actor(role="superadmin"):
    return SimpleNamespace(
        id=uuid4(), username="admin", display_name="Administrator", role=role, is_active=True
    )


def request():
    return SimpleNamespace(
        client=SimpleNamespace(host="127.0.0.1"),
        headers={"user-agent": "Audit test"},
        state=SimpleNamespace(request_id="request-123"),
        url=SimpleNamespace(path="/api/admin/test"),
        method="POST",
    )


def user(**overrides):
    values = {
        "id": uuid4(), "username": "target", "display_name": "Target User", "email": None,
        "password_hash": "never-serialize", "role": "user", "is_active": True,
        "auth_provider": "local",
    }
    values.update(overrides)
    return SimpleNamespace(**values)


class AuditSanitizerTests(unittest.TestCase):
    def test_sensitive_keys_and_jwt_values_are_redacted_recursively(self):
        source = {
            "password": "secret",
            "nested": {"authorization": "Bearer abc.def.ghi", "safe": "value"},
            "items": [{"bot_token": "token-value"}],
            "note": "token eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.signature",
        }
        sanitized = sanitize_audit_value(source)
        serialized = json.dumps(sanitized)
        self.assertNotIn("secret", serialized)
        self.assertNotIn("token-value", serialized)
        self.assertNotIn("eyJhbGci", serialized)
        self.assertEqual(sanitized["nested"]["safe"], "value")

    def test_message_bodies_and_storage_paths_are_never_kept(self):
        sanitized = sanitize_audit_value({"body": "private text", "storage_path": "C:/secret/file", "count": 2})
        self.assertEqual(sanitized["body"], "[REDACTED]")
        self.assertEqual(sanitized["storage_path"], "[REDACTED]")
        self.assertEqual(sanitized["count"], 2)


class AuditPersistenceTests(unittest.IsolatedAsyncioTestCase):
    async def test_request_context_and_actor_snapshot_are_stored(self):
        session = AuditSession()
        current_actor = actor()
        event = await record_audit_event(
            session,
            event_type="user.updated",
            category="users",
            action="update",
            status="success",
            actor=current_actor,
            target_type="user",
            target_id=uuid4(),
            target_label="target",
            details={"safe": True},
            request=request(),
        )
        self.assertEqual(event.actor_username, "admin")
        self.assertEqual(event.actor_role, "superadmin")
        self.assertEqual(event.request_id, "request-123")
        self.assertEqual(event.source_ip, "127.0.0.1")

    async def test_user_creation_audit_never_contains_password(self):
        session = AuditSession()
        created = user()
        payload = AdminUserCreate(
            username="target", display_name="Target User", password="new-password", role="user"
        )
        with patch("app.api.routes.admin_users.create_local_user", AsyncMock(return_value=created)):
            await create_user(payload, request(), session, actor())
        serialized = json.dumps(session.events[0].details)
        self.assertEqual(session.events[0].event_type, "user.created")
        self.assertNotIn("new-password", serialized)

    async def test_admin_change_is_not_committed_when_audit_insert_fails(self):
        session = AuditSession()
        created = user()
        payload = AdminUserCreate(
            username="target", display_name="Target User", password="new-password", role="user"
        )
        with (
            patch("app.api.routes.admin_users.create_local_user", AsyncMock(return_value=created)),
            patch("app.api.routes.admin_users.record_audit_event", AsyncMock(side_effect=RuntimeError("audit failed"))),
        ):
            with self.assertRaisesRegex(RuntimeError, "audit failed"):
                await create_user(payload, request(), session, actor())
        self.assertEqual(session.commits, 0)

    async def test_user_disable_has_before_after_metadata(self):
        session = AuditSession()
        target = user()

        async def update(_session, current, payload, commit=False):
            current.is_active = payload.is_active
            return current

        with (
            patch("app.api.routes.admin_users.get_user_by_id", AsyncMock(return_value=target)),
            patch("app.api.routes.admin_users.update_user", update),
        ):
            await patch_user(target.id, AdminUserUpdate(is_active=False), request(), session, actor())
        disabled = next(event for event in session.events if event.event_type == "user.disabled")
        self.assertEqual(disabled.details["changes"]["is_active"], {"old": True, "new": False})

    async def test_password_reset_and_bot_rotation_do_not_store_secrets(self):
        session = AuditSession()
        target = user()
        with (
            patch("app.api.routes.admin_users.get_user_by_id", AsyncMock(return_value=target)),
            patch("app.api.routes.admin_users.reset_local_user_password", AsyncMock(return_value=target)),
        ):
            await reset_password(
                target.id, AdminPasswordReset(new_password="changed-password"), request(), session, actor()
            )
        self.assertEqual(session.events[-1].details, {"password_reset": True})
        self.assertNotIn("changed-password", json.dumps(session.events[-1].details))

        bot_user = user(username="alerts_bot", role="bot", auth_provider="bot")
        bot = SimpleNamespace(id=uuid4(), name="Alerts", user=bot_user, is_active=True)
        with (
            patch("app.api.routes.admin_bots.load_bot_with_user", AsyncMock(return_value=bot)),
            patch("app.api.routes.admin_bots.rotate_bot_token", AsyncMock(return_value=(bot, "full-bot-token"))),
            patch("app.api.routes.admin_bots.BotPublic.model_validate", return_value=SimpleNamespace()),
            patch("app.api.routes.admin_bots.BotTokenRotateResponse", return_value=SimpleNamespace()),
        ):
            await post_rotate_token(bot.id, request(), session, actor())
        self.assertEqual(session.events[-1].details, {"token_rotated": True})
        self.assertNotIn("full-bot-token", json.dumps(session.events[-1].details))


if __name__ == "__main__":
    unittest.main()
