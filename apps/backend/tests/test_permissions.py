import unittest
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch
from uuid import uuid4

from fastapi import HTTPException

from app.api.routes.admin_permissions import get_permissions, put_user_permissions
from app.core.permissions import CAN_BROADCAST, CAN_PIN_MESSAGES
from app.schemas.permission import UserPermissionsUpdate
from app.services import permissions


class PermissionSession:
    def __init__(self):
        self.added = []
        self.executed = []
        self.commits = 0
        self.rollbacks = 0

    def add(self, value):
        self.added.append(value)

    async def execute(self, statement):
        self.executed.append(statement)

    async def flush(self):
        return None

    async def commit(self):
        self.commits += 1

    async def rollback(self):
        self.rollbacks += 1


def user(role="user", **overrides):
    values = {
        "id": uuid4(),
        "username": f"{role}_user",
        "display_name": "Test User",
        "role": role,
        "is_active": True,
        "auth_provider": "local",
    }
    values.update(overrides)
    return SimpleNamespace(**values)


def request():
    return SimpleNamespace(client=None, headers={}, state=SimpleNamespace(request_id="request-1"))


class PermissionCalculationTests(unittest.IsolatedAsyncioTestCase):
    async def test_superadmin_has_all_active_permissions_implicitly(self):
        with patch("app.services.permissions.active_permission_keys", AsyncMock(return_value={CAN_PIN_MESSAGES, CAN_BROADCAST})):
            effective = await permissions.get_effective_permission_keys(AsyncMock(), user("superadmin"))
        self.assertEqual(effective, [CAN_BROADCAST, CAN_PIN_MESSAGES])

    async def test_admin_and_moderator_do_not_receive_sensitive_permissions_by_role(self):
        with patch("app.services.permissions.get_explicit_permission_keys", AsyncMock(return_value=[])):
            self.assertEqual(await permissions.get_effective_permission_keys(AsyncMock(), user("admin")), [])
            self.assertEqual(await permissions.get_effective_permission_keys(AsyncMock(), user("moderator")), [])

    async def test_disabled_users_and_bots_have_no_effective_permissions(self):
        session = AsyncMock()
        disabled = user("user", is_active=False)
        bot = user("bot", auth_provider="bot")
        self.assertEqual(await permissions.get_effective_permission_keys(session, disabled), [])
        self.assertEqual(await permissions.get_effective_permission_keys(session, bot), [])

    async def test_explicit_grant_and_revoke_write_audit_events(self):
        session = PermissionSession()
        actor = user("superadmin")
        target = user("user")
        with (
            patch("app.services.permissions.validate_permission_keys", AsyncMock(return_value=[CAN_PIN_MESSAGES])),
            patch("app.services.permissions.get_explicit_permission_keys", AsyncMock(side_effect=[[], [CAN_PIN_MESSAGES]])),
            patch("app.services.permissions.get_effective_permission_keys", AsyncMock(return_value=[CAN_PIN_MESSAGES])),
            patch("app.services.permissions.record_audit_event", AsyncMock()) as record,
        ):
            state = await permissions.replace_user_permissions(
                session,
                actor=actor,
                target_user=target,
                permission_keys=[CAN_PIN_MESSAGES],
                request=request(),
            )
        self.assertEqual(state.effective_permissions, [CAN_PIN_MESSAGES])
        self.assertEqual(len(session.added), 1)
        record.assert_awaited_once()
        self.assertEqual(record.await_args.kwargs["event_type"], "permission.granted")

        session = PermissionSession()
        with (
            patch("app.services.permissions.validate_permission_keys", AsyncMock(return_value=[])),
            patch("app.services.permissions.get_explicit_permission_keys", AsyncMock(side_effect=[[CAN_PIN_MESSAGES], []])),
            patch("app.services.permissions.get_effective_permission_keys", AsyncMock(return_value=[])),
            patch("app.services.permissions.record_audit_event", AsyncMock()) as record,
        ):
            await permissions.replace_user_permissions(
                session, actor=actor, target_user=target, permission_keys=[], request=request()
            )
        self.assertEqual(len(session.executed), 1)
        self.assertEqual(record.await_args.kwargs["event_type"], "permission.revoked")

    async def test_unchanged_bulk_update_writes_no_duplicate_audit_event(self):
        session = PermissionSession()
        with (
            patch("app.services.permissions.validate_permission_keys", AsyncMock(return_value=[CAN_BROADCAST])),
            patch("app.services.permissions.get_explicit_permission_keys", AsyncMock(side_effect=[[CAN_BROADCAST], [CAN_BROADCAST]])),
            patch("app.services.permissions.get_effective_permission_keys", AsyncMock(return_value=[CAN_BROADCAST])),
            patch("app.services.permissions.record_audit_event", AsyncMock()) as record,
        ):
            await permissions.replace_user_permissions(
                session,
                actor=user("superadmin"),
                target_user=user("user"),
                permission_keys=[CAN_BROADCAST],
                request=request(),
            )
        record.assert_not_awaited()

    async def test_invalid_assignment_targets_are_rejected(self):
        session = PermissionSession()
        actor = user("superadmin")
        with self.assertRaises(HTTPException):
            await permissions.replace_user_permissions(
                session, actor=actor, target_user=actor, permission_keys=[CAN_BROADCAST]
            )
        with self.assertRaises(HTTPException):
            await permissions.replace_user_permissions(
                session, actor=actor, target_user=user("bot", auth_provider="bot"), permission_keys=[CAN_BROADCAST]
            )
        with self.assertRaises(HTTPException):
            await permissions.replace_user_permissions(
                session, actor=user("admin"), target_user=user("user"), permission_keys=[CAN_BROADCAST]
            )


class PermissionApiTests(unittest.IsolatedAsyncioTestCase):
    async def test_admin_cannot_view_or_manage_permission_catalog(self):
        with self.assertRaises(HTTPException) as raised:
            await get_permissions(AsyncMock(), user("admin"))
        self.assertEqual(raised.exception.status_code, 403)

    async def test_update_rolls_back_when_persistence_fails(self):
        session = PermissionSession()
        target = user("user")
        with (
            patch("app.api.routes.admin_permissions.get_user_by_id", AsyncMock(return_value=target)),
            patch("app.api.routes.admin_permissions.replace_user_permissions", AsyncMock(side_effect=RuntimeError("audit failed"))),
        ):
            with self.assertRaisesRegex(RuntimeError, "audit failed"):
                await put_user_permissions(
                    target.id,
                    UserPermissionsUpdate(permissions=[CAN_BROADCAST]),
                    request(),
                    session,
                    user("superadmin"),
                )
        self.assertEqual(session.commits, 0)
        self.assertEqual(session.rollbacks, 1)


if __name__ == "__main__":
    unittest.main()
