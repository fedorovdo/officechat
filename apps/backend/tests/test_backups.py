import asyncio
import json
import unittest
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch
from uuid import UUID, uuid4

from fastapi import HTTPException
from fastapi.responses import JSONResponse

from app.api.deps import require_superadmin_user
from app.api.routes.admin_backups import get_backup, get_backup_status, get_backups
from app.schemas.backup import BackupItemPublic, BackupPagePublic, BackupStatusPublic
from app.services.backup_agent import (
    BackupAgentClient,
    BackupAgentProtocolError,
    BackupAgentRemoteError,
    BackupAgentUnavailableError,
)


REQUEST_ID = UUID("00000000-0000-4000-8000-000000000123")


def actor(role="superadmin"):
    return SimpleNamespace(
        id=uuid4(), username=role, display_name=role.title(), role=role, is_active=True
    )


def request():
    return SimpleNamespace(
        url=SimpleNamespace(path="/api/admin/backups"),
        method="GET",
        client=None,
        headers={},
        state=SimpleNamespace(request_id="request-1"),
    )


def status_payload():
    return {
        "agent_status": "available",
        "backup_health": "healthy",
        "current_result": "success",
        "last_run": None,
        "last_success": None,
        "backup_root_capacity": {
            "total_bytes": 1000, "used_bytes": 250, "free_bytes": 750, "usage_percent": 25,
        },
        "timer": {
            "installed": True, "enabled": True, "active": True,
            "next_run_at": None, "last_trigger_at": None, "unit_name": "officechat-backup.timer",
        },
        "retention": {"daily": 14, "weekly": 8, "monthly": 12},
        "offsite": {"configured": False, "required": False, "status": "not_configured"},
        "warnings": ["OFFSITE_NOT_CONFIGURED"],
    }


def item_payload():
    return {
        "backup_id": "officechat-backup-20260804-120000Z",
        "created_at": "2026-08-04T12:00:00Z",
        "backup_type": "unknown",
        "size_bytes": 1234,
        "verification_status": "passed",
        "verified_at": None,
        "offsite_status": "copied",
        "officechat_version": "0.1.0-rc11",
        "build_sha": "abcdef012345",
        "alembic_revision": "20260728_0026",
        "postgresql_version": "16.4",
        "pre_upgrade": False,
        "protected": False,
        "warnings": [],
        "components": ["database", "uploads"],
    }


class FakeClient:
    def __init__(self, response=None, error=None):
        self.response = response
        self.error = error
        self.calls = []

    async def request(self, operation, params=None):
        self.calls.append((operation, params))
        if self.error:
            raise self.error
        return self.response


class BackupAuthorizationTests(unittest.IsolatedAsyncioTestCase):
    async def test_only_superadmin_is_allowed(self):
        self.assertEqual((await require_superadmin_user(request(), actor())).role, "superadmin")
        for role in ("admin", "user"):
            with patch("app.api.deps.record_audit_event_best_effort", AsyncMock()):
                with self.assertRaises(HTTPException) as raised:
                    await require_superadmin_user(request(), actor(role))
            self.assertEqual(raised.exception.status_code, 403)


class BackupApiTests(unittest.IsolatedAsyncioTestCase):
    async def test_superadmin_status_list_and_detail(self):
        status = await get_backup_status(actor(), FakeClient(status_payload()))
        self.assertIsInstance(status, BackupStatusPublic)
        page = await get_backups(actor(), FakeClient({
            "items": [item_payload()], "page": 1, "limit": 25, "total": 1, "has_next": False,
        }), "1", "25")
        self.assertIsInstance(page, BackupPagePublic)
        detail = await get_backup(item_payload()["backup_id"], actor(), FakeClient(item_payload()))
        self.assertIsInstance(detail, BackupItemPublic)

    async def test_status_is_200_shape_when_agent_is_unavailable(self):
        result = await get_backup_status(actor(), FakeClient(error=BackupAgentUnavailableError()))
        self.assertEqual(result.agent_status, "unavailable")
        self.assertEqual(result.backup_health, "unknown")
        self.assertEqual(result.error_code, "BACKUP_AGENT_UNAVAILABLE")

    async def test_list_and_detail_are_503_when_agent_is_unavailable(self):
        page = await get_backups(actor(), FakeClient(error=BackupAgentUnavailableError()), "1", "25")
        detail = await get_backup(item_payload()["backup_id"], actor(), FakeClient(error=BackupAgentUnavailableError()))
        self.assertIsInstance(page, JSONResponse)
        self.assertEqual(page.status_code, 503)
        self.assertEqual(detail.status_code, 503)

    async def test_invalid_id_missing_backup_and_pagination_have_safe_errors(self):
        invalid = await get_backup("../private", actor(), FakeClient())
        self.assertEqual(invalid.status_code, 400)
        missing = await get_backup(
            item_payload()["backup_id"], actor(), FakeClient(error=BackupAgentRemoteError("BACKUP_NOT_FOUND"))
        )
        self.assertEqual(missing.status_code, 404)
        pagination = await get_backups(actor(), FakeClient(), "0", "101")
        self.assertEqual(pagination.status_code, 400)

    def test_public_contract_does_not_contain_filesystem_or_private_fields(self):
        serialized = BackupItemPublic.model_validate(item_payload()).model_dump()
        forbidden = {"local_path", "offsite_path", "destination", "database_url", "storage_path"}
        self.assertTrue(forbidden.isdisjoint(serialized))


class BackupAgentClientTests(unittest.IsolatedAsyncioTestCase):
    def fake_streams(self, response):
        reader = SimpleNamespace(readline=AsyncMock(return_value=response))
        writer = SimpleNamespace(
            write=MagicMock(), drain=AsyncMock(), close=MagicMock(), wait_closed=AsyncMock()
        )
        return reader, writer

    async def test_valid_response_and_request_id_match(self):
        response = {
            "protocol_version": 1,
            "request_id": str(REQUEST_ID),
            "ok": True,
            "data": {"safe": True},
        }
        streams = self.fake_streams((json.dumps(response) + "\n").encode())
        with (
            patch("app.services.backup_agent.uuid.uuid4", return_value=REQUEST_ID),
            patch("app.services.backup_agent.asyncio.open_unix_connection", AsyncMock(return_value=streams)),
        ):
            result = await BackupAgentClient("/run/agent.sock").request("status")
        self.assertEqual(result, {"safe": True})

    async def test_timeout_oversize_mismatch_and_remote_error_are_safe(self):
        client = BackupAgentClient("/private/socket/path", max_response_bytes=64)
        with patch("app.services.backup_agent.asyncio.open_unix_connection", AsyncMock(side_effect=asyncio.TimeoutError)):
            with self.assertRaises(BackupAgentUnavailableError) as unavailable:
                await client.request("status")
        self.assertNotIn("/private", str(unavailable.exception))

        reader = SimpleNamespace(readline=AsyncMock(side_effect=ValueError("separator")))
        writer = SimpleNamespace(write=MagicMock(), drain=AsyncMock(), close=MagicMock(), wait_closed=AsyncMock())
        with patch("app.services.backup_agent.asyncio.open_unix_connection", AsyncMock(return_value=(reader, writer))):
            with self.assertRaises(BackupAgentProtocolError):
                await client.request("status")

        mismatched = self.fake_streams(json.dumps({
            "protocol_version": 1, "request_id": str(uuid4()), "ok": True, "data": {},
        }).encode() + b"\n")
        with patch("app.services.backup_agent.asyncio.open_unix_connection", AsyncMock(return_value=mismatched)):
            with self.assertRaises(BackupAgentProtocolError):
                await BackupAgentClient("/run/agent.sock").request("status")

        remote = self.fake_streams((json.dumps({
            "protocol_version": 1, "request_id": str(REQUEST_ID), "ok": False,
            "error": {"code": "BACKUP_NOT_FOUND", "message": "/secret/path"},
        }) + "\n").encode())
        with (
            patch("app.services.backup_agent.uuid.uuid4", return_value=REQUEST_ID),
            patch("app.services.backup_agent.asyncio.open_unix_connection", AsyncMock(return_value=remote)),
        ):
            with self.assertRaises(BackupAgentRemoteError) as raised:
                await BackupAgentClient("/run/agent.sock").request("get_backup")
        self.assertEqual(str(raised.exception), "BACKUP_NOT_FOUND")
        self.assertNotIn("secret", str(raised.exception))


if __name__ == "__main__":
    unittest.main()
