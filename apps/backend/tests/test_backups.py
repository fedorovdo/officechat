import asyncio
import json
import unittest
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch
from uuid import UUID, uuid4

from fastapi import HTTPException
from fastapi.responses import JSONResponse
from pydantic import ValidationError

from app.api.deps import require_superadmin_user
from app.api.routes.admin_backups import (
    create_backup_job,
    get_active_backup_job,
    get_backup,
    get_backup_job,
    get_backup_status,
    get_backups,
    verify_backup,
)
from app.schemas.backup import BackupItemPublic, BackupJobCreate, BackupPagePublic, BackupStatusPublic
from app.services.backup_agent import (
    BackupAgentClient,
    BackupAgentProtocolError,
    BackupAgentRemoteError,
    BackupAgentUnavailableError,
)
from app.services.backup_job_audit import reconcile_backup_job_audits


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


def job_payload(state="queued", operation="create_backup", backup_id=None):
    return {
        "job_id": "00000000-0000-4000-8000-000000000123",
        "operation": operation,
        "state": state,
        "phase": state,
        "backup_id": backup_id,
        "requested_at": "2026-08-05T10:00:00Z",
        "started_at": None,
        "finished_at": None,
        "success": None,
        "exit_code": None,
        "safe_message": "Backup operation is queued",
        "last_error": None,
    }


def terminal_job_payload(state="succeeded", operation="create_backup"):
    payload = job_payload(state=state, operation=operation)
    payload.update({
        "phase": "completed" if state == "succeeded" else "error",
        "started_at": "2026-08-05T10:00:01Z",
        "finished_at": "2026-08-05T10:01:00Z",
        "success": state == "succeeded",
        "exit_code": 0 if state == "succeeded" else 1,
        "last_error": None if state == "succeeded" else f"JOB_{state.upper()}",
        "requested_by_user_id": "11111111-1111-4111-8111-111111111111",
        "requested_by_login": "original-admin",
    })
    return payload


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


class ReconciliationClient:
    def __init__(self, job=None, *, fail_complete_once=False):
        self.job = job
        self.claim_state = "pending" if job else "empty"
        self.claim_id = "22222222-2222-4222-8222-222222222222"
        self.fail_complete_once = fail_complete_once
        self.lock = asyncio.Lock()
        self.calls = []

    async def request(self, operation, params=None):
        self.calls.append((operation, params))
        if operation == "claim_job_audit":
            async with self.lock:
                if self.claim_state != "pending":
                    return {"claim_id": None, "job": None}
                self.claim_state = "claimed"
                return {"claim_id": self.claim_id, "job": self.job}
        if operation == "complete_job_audit":
            if self.fail_complete_once:
                self.fail_complete_once = False
                raise BackupAgentUnavailableError("lost acknowledgement")
            self.claim_state = "reconciled"
            return {"job_id": params["job_id"], "audit_reconciled_at": "2026-08-05T10:02:00Z"}
        if operation == "release_job_audit":
            self.claim_state = "pending"
            return {"job_id": params["job_id"], "released": True}
        if operation == "status":
            return status_payload()
        raise AssertionError(f"Unexpected operation: {operation}")

    def expire_claim(self):
        if self.claim_state == "claimed":
            self.claim_state = "pending"


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
        with self.assertRaises(ValidationError):
            BackupJobCreate.model_validate({
                "operation": "create_backup",
                "requested_by_login": "spoofed-admin",
            })

    @patch("app.api.routes.admin_backups.reconcile_backup_job_audits", new_callable=AsyncMock)
    async def test_every_backup_center_get_runs_terminal_reconciliation(self, reconcile):
        await get_backup_status(actor(), FakeClient(status_payload()))
        await get_backups(
            actor(),
            FakeClient({"items": [], "page": 1, "limit": 25, "total": 0, "has_next": False}),
            "1",
            "25",
        )
        await get_backup(item_payload()["backup_id"], actor(), FakeClient(item_payload()))
        await get_active_backup_job(actor(), FakeClient({"job": None}))
        await get_backup_job(job_payload()["job_id"], request(), actor(), FakeClient(job_payload()))
        self.assertEqual(reconcile.await_count, 5)

    @patch("app.api.routes.admin_backups.record_audit_event_best_effort", new_callable=AsyncMock)
    async def test_create_verify_job_status_and_active_contracts(self, audit):
        admin = actor()
        create_client = FakeClient(job_payload())
        created = await create_backup_job(
            BackupJobCreate(operation="create_backup"), request(), admin, create_client
        )
        self.assertEqual(created.state, "queued")
        self.assertEqual(create_client.calls[0][0], "create_backup")
        self.assertEqual(create_client.calls[0][1]["requested_by_login"], "superadmin")
        self.assertEqual(create_client.calls[0][1]["requested_by_user_id"], str(admin.id))

        verify_client = FakeClient(job_payload(operation="verify_backup", backup_id=item_payload()["backup_id"]))
        verified = await verify_backup(item_payload()["backup_id"], request(), admin, verify_client)
        self.assertEqual(verified.operation, "verify_backup")
        self.assertEqual(verify_client.calls[0][0], "verify_backup")
        self.assertEqual(verify_client.calls[0][1]["requested_by_login"], "superadmin")

        job_client = FakeClient(job_payload(state="running"))
        current = await get_backup_job(job_payload()["job_id"], request(), actor(), job_client)
        self.assertEqual(current.state, "running")
        active = await get_active_backup_job(actor(), FakeClient({"job": job_payload(state="running")}))
        self.assertEqual(active.job.state, "running")
        self.assertGreaterEqual(audit.await_count, 4)

    @patch("app.api.routes.admin_backups.record_audit_event_best_effort", new_callable=AsyncMock)
    async def test_job_errors_are_safe_and_mapped(self, _audit):
        conflict = await create_backup_job(
            BackupJobCreate(operation="create_backup"),
            request(),
            actor(),
            FakeClient(error=BackupAgentRemoteError("JOB_CONFLICT")),
        )
        self.assertEqual(conflict.status_code, 409)
        backlog = await create_backup_job(
            BackupJobCreate(operation="create_backup"),
            request(),
            actor(),
            FakeClient(error=BackupAgentRemoteError("AUDIT_BACKLOG_FULL")),
        )
        self.assertEqual(backlog.status_code, 503)
        unavailable = await create_backup_job(
            BackupJobCreate(operation="create_backup"),
            request(),
            actor(),
            FakeClient(error=BackupAgentUnavailableError()),
        )
        self.assertEqual(unavailable.status_code, 503)
        invalid = await get_backup_job("../secret", request(), actor(), FakeClient())
        self.assertEqual(invalid.status_code, 400)
        self.assertNotIn("secret", json.loads(invalid.body)["detail"])


class BackupTerminalAuditTests(unittest.IsolatedAsyncioTestCase):
    @patch("app.services.backup_job_audit.persist_terminal_audit", new_callable=AsyncMock)
    async def test_status_reconciles_succeeded_job_without_frontend_polling(self, persist):
        client = ReconciliationClient(terminal_job_payload("succeeded"))
        result = await get_backup_status(actor(), client)

        self.assertIsInstance(result, BackupStatusPublic)
        persist.assert_awaited_once()
        terminal_job = persist.await_args.args[0]
        self.assertEqual(terminal_job.state, "succeeded")
        self.assertEqual(terminal_job.requested_by_login, "original-admin")
        self.assertEqual(client.claim_state, "reconciled")

    @patch("app.services.backup_job_audit.persist_terminal_audit", new_callable=AsyncMock)
    async def test_failed_and_interrupted_jobs_are_reconciled_late(self, persist):
        for state in ("failed", "interrupted"):
            with self.subTest(state=state):
                client = ReconciliationClient(terminal_job_payload(state))
                await reconcile_backup_job_audits(client)
                self.assertEqual(client.claim_state, "reconciled")
        self.assertEqual([call.args[0].state for call in persist.await_args_list], ["failed", "interrupted"])

    @patch("app.services.backup_job_audit.persist_terminal_audit", new_callable=AsyncMock)
    async def test_repeated_and_parallel_reconciliation_claims_write_once(self, persist):
        async def delayed_persist(_job):
            await asyncio.sleep(0.02)
            return True

        persist.side_effect = delayed_persist
        client = ReconciliationClient(terminal_job_payload())
        await asyncio.gather(
            reconcile_backup_job_audits(client),
            reconcile_backup_job_audits(client),
        )
        await reconcile_backup_job_audits(client)

        persist.assert_awaited_once()
        self.assertEqual(client.claim_state, "reconciled")

    async def test_lost_ack_and_backend_restart_do_not_duplicate_audit(self):
        client = ReconciliationClient(terminal_job_payload(), fail_complete_once=True)
        durable_audit_ids = set()
        insert_count = 0

        async def idempotent_persist(job):
            nonlocal insert_count
            if job.job_id in durable_audit_ids:
                return False
            durable_audit_ids.add(job.job_id)
            insert_count += 1
            return True

        with patch("app.services.backup_job_audit.persist_terminal_audit", side_effect=idempotent_persist):
            await reconcile_backup_job_audits(client)
            self.assertEqual(client.claim_state, "claimed")
            client.expire_claim()
            await reconcile_backup_job_audits(client)

        self.assertEqual(insert_count, 1)
        self.assertEqual(client.claim_state, "reconciled")

    @patch("app.services.backup_job_audit.persist_terminal_audit", new_callable=AsyncMock)
    async def test_commit_failure_releases_claim_and_retry_succeeds(self, persist):
        persist.side_effect = [RuntimeError("database unavailable"), True]
        client = ReconciliationClient(terminal_job_payload())

        await reconcile_backup_job_audits(client)
        self.assertEqual(client.claim_state, "pending")
        await reconcile_backup_job_audits(client)

        self.assertEqual(persist.await_count, 2)
        self.assertEqual(client.claim_state, "reconciled")


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
