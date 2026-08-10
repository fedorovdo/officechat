from __future__ import annotations

import importlib.util
import json
import os
import socket
import sys
import tempfile
import threading
import time
import unittest
import uuid
from concurrent.futures import ThreadPoolExecutor
from dataclasses import replace
from datetime import datetime, timezone
from pathlib import Path
from unittest.mock import MagicMock, patch


MODULE_PATH = Path(__file__).resolve().parents[1] / "backup_agent.py"
SPEC = importlib.util.spec_from_file_location("officechat_backup_agent", MODULE_PATH)
assert SPEC and SPEC.loader
backup_agent = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = backup_agent
SPEC.loader.exec_module(backup_agent)
ACTOR_USER_ID = "11111111-1111-4111-8111-111111111111"
ACTOR_LOGIN = "backup_admin"


def timestamp() -> str:
    return datetime(2026, 8, 4, 12, 0, tzinfo=timezone.utc).isoformat()


class BackupAgentTestCase(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        self.backup_root = self.root / "backups"
        self.status_dir = self.root / "status"
        self.runtime_dir = self.root / "run"
        self.backup_root.mkdir()
        self.status_dir.mkdir()
        self.runtime_dir.mkdir()
        self.backup_config = self.root / "backup.conf"
        self.backup_config.write_text(
            "KEEP_DAILY=14\nKEEP_WEEKLY=8\nKEEP_MONTHLY=12\nOFFSITE_ROOT=\nREQUIRE_OFFSITE=no\n",
            encoding="utf-8",
        )
        self.config = backup_agent.AgentConfig(
            backup_root=self.backup_root,
            status_directory=self.status_dir,
            status_file=self.status_dir / "latest.json",
            backup_config_path=self.backup_config,
            socket_path=self.runtime_dir / "agent.sock",
            max_list_limit=100,
            request_max_bytes=1024,
            response_max_bytes=262_144,
            io_timeout_seconds=1,
            state_directory=self.root / "agent-state",
            max_job_history=20,
        )
        self.inspector = backup_agent.BackupInspector(self.config)

    def tearDown(self) -> None:
        self.temporary.cleanup()

    def write_status(self) -> None:
        run = {
            "timestamp": timestamp(),
            "success": True,
            "backup_id": "officechat-backup-20260804-120000Z",
            "backup_size_bytes": 1234,
            "duration_seconds": 10,
            "offsite_status": "copied",
            "verification_status": "passed",
            "last_error": None,
        }
        self.config.status_file.write_text(
            json.dumps({
                **run,
                "current_result": "success",
                "last_run": run,
                "last_success": {key: value for key, value in run.items() if key != "last_error"},
            }),
            encoding="utf-8",
        )

    def make_backup(
        self,
        backup_id: str = "officechat-backup-20260804-120000Z",
        *,
        manifest: dict | None = None,
        receipt: dict | None = None,
    ) -> Path:
        directory = self.backup_root / backup_id
        (directory / "metadata").mkdir(parents=True)
        (directory / "database").mkdir()
        (directory / "database" / "officechat.dump").write_bytes(b"dump")
        if manifest is not None:
            (directory / "metadata" / "manifest.json").write_text(json.dumps(manifest), encoding="utf-8")
        if receipt is not None:
            (directory / "metadata" / "offsite-receipt.json").write_text(json.dumps(receipt), encoding="utf-8")
        return directory

    @staticmethod
    def wait_for_terminal(manager, job_id: str):
        for _ in range(100):
            job = manager.get_job(job_id)
            if job["state"] in backup_agent.TERMINAL_JOB_STATES:
                return job
            time.sleep(0.01)
        raise AssertionError("job did not finish")

    @patch.object(backup_agent, "read_timer_status")
    def test_valid_latest_json(self, timer_status) -> None:
        timer_status.return_value = ({
            "installed": True, "enabled": True, "active": True,
            "next_run_at": timestamp(), "last_trigger_at": timestamp(),
            "unit_name": "officechat-backup.timer",
        }, [])
        self.write_status()
        result = self.inspector.status()
        self.assertEqual(result["backup_health"], "healthy")
        self.assertEqual(result["last_success"]["backup_id"], "officechat-backup-20260804-120000Z")
        self.assertNotIn("STATUS_MISSING", result["warnings"])

    @patch.object(backup_agent, "read_timer_status", return_value=({}, ["TIMER_UNAVAILABLE"]))
    def test_missing_latest_json(self, _timer_status) -> None:
        result = self.inspector.status()
        self.assertEqual(result["backup_health"], "never_run")
        self.assertIn("STATUS_MISSING", result["warnings"])

    @patch.object(backup_agent, "read_timer_status", return_value=({}, []))
    def test_corrupt_and_oversized_latest_json(self, _timer_status) -> None:
        self.config.status_file.write_text("{", encoding="utf-8")
        self.assertIn("STATUS_CORRUPT", self.inspector.status()["warnings"])
        self.config.status_file.write_bytes(b"x" * 262_145)
        self.assertIn("STATUS_CORRUPT", self.inspector.status()["warnings"])

    @unittest.skipUnless(hasattr(os, "symlink"), "symlinks unavailable")
    @patch.object(backup_agent, "read_timer_status", return_value=({}, []))
    def test_symlink_latest_json_is_rejected(self, _timer_status) -> None:
        target = self.root / "real-status.json"
        target.write_text("{}", encoding="utf-8")
        try:
            self.config.status_file.symlink_to(target)
        except OSError as exc:
            self.skipTest(str(exc))
        self.assertIn("STATUS_CORRUPT", self.inspector.status()["warnings"])

    def test_valid_backup_and_offsite_path_redaction(self) -> None:
        directory = self.make_backup(
            manifest={
                "timestamp": timestamp(), "officechat_version": "0.1.0-rc11",
                "build_sha": "abcdef012345", "alembic_revision": "20260728_0026",
                "postgresql_version": "16.4", "verification_status": "passed",
                "verified_at": timestamp(), "backup_type": "scheduled", "pre_upgrade": False,
                "detected_components": ["database", "uploads"],
            },
            receipt={"status": "copied", "destination": "/private/offsite/path"},
        )
        (directory / "uploads").mkdir()
        (directory / "uploads" / "uploads.tar.gz").write_bytes(b"uploads")
        item = self.inspector.backup_item(directory.name)
        self.assertEqual(item["backup_type"], "scheduled")
        self.assertEqual(item["verification_status"], "passed")
        self.assertGreater(item["size_bytes"], 0)
        self.assertNotIn("/private/offsite/path", json.dumps(item))

    def test_legacy_manifest_and_missing_manifest(self) -> None:
        legacy = self.make_backup(manifest={"timestamp": timestamp(), "pre_upgrade": False})
        self.assertEqual(self.inspector.backup_item(legacy.name)["backup_type"], "unknown")
        missing = self.make_backup("officechat-backup-20260803-120000Z")
        item = self.inspector.backup_item(missing.name)
        self.assertIn("MANIFEST_MISSING", item["warnings"])
        self.assertIsNotNone(item["created_at"])

    def test_pre_upgrade_is_derived_only_from_reliable_marker(self) -> None:
        directory = self.make_backup(manifest={"timestamp": timestamp(), "pre_upgrade": False})
        (directory / "PROTECTED").touch()
        item = self.inspector.backup_item(directory.name)
        self.assertEqual(item["backup_type"], "pre_upgrade")
        self.assertTrue(item["protected"])

    def test_invalid_partial_symlink_and_unknown_ids(self) -> None:
        self.make_backup()
        (self.backup_root / "officechat-backup-20260805-120000Z.partial").mkdir()
        (self.backup_root / "not-a-backup").mkdir()
        target = self.root / "outside"
        target.mkdir()
        try:
            (self.backup_root / "officechat-backup-20260806-120000Z").symlink_to(target, target_is_directory=True)
        except OSError:
            pass
        result = self.inspector.list_backups(1, 25)
        self.assertEqual([item["backup_id"] for item in result["items"]], ["officechat-backup-20260804-120000Z"])
        with self.assertRaisesRegex(backup_agent.AgentError, "invalid"):
            self.inspector.backup_item("../escape")
        with self.assertRaises(backup_agent.AgentError) as missing:
            self.inspector.backup_item("officechat-backup-20260101-000000Z")
        self.assertEqual(missing.exception.code, "BACKUP_NOT_FOUND")

    def test_newest_first_pagination_and_limit(self) -> None:
        for day in range(1, 4):
            self.make_backup(f"officechat-backup-2026080{day}-120000Z", manifest={"timestamp": timestamp()})
        first = self.inspector.list_backups(1, 2)
        self.assertEqual(first["total"], 3)
        self.assertTrue(first["has_next"])
        self.assertEqual(first["items"][0]["backup_id"], "officechat-backup-20260803-120000Z")
        second = self.inspector.list_backups(2, 2)
        self.assertFalse(second["has_next"])
        with self.assertRaises(backup_agent.AgentError):
            self.inspector.list_backups(1, 101)

    def test_size_calculation_filesystem_error_is_safe(self) -> None:
        directory = self.make_backup(manifest={"timestamp": timestamp()})
        original_scandir = backup_agent.os.scandir

        def failing_scandir(path):
            if Path(path) == directory:
                raise PermissionError("private path")
            return original_scandir(path)

        with patch.object(backup_agent.os, "scandir", side_effect=failing_scandir):
            item = self.inspector.backup_item(directory.name)
        self.assertIsNone(item["size_bytes"])
        self.assertIn("SIZE_UNAVAILABLE", item["warnings"])

    def test_timer_unavailable_and_fixed_argv(self) -> None:
        with patch.object(backup_agent.subprocess, "run", side_effect=FileNotFoundError):
            timer, warnings = backup_agent.read_timer_status("officechat-backup.timer")
        self.assertFalse(timer["installed"])
        self.assertEqual(warnings, ["TIMER_UNAVAILABLE"])
        completed = backup_agent.subprocess.CompletedProcess([], 0, "LoadState=loaded\nUnitFileState=enabled\nActiveState=active\n", "")
        with patch.object(backup_agent.subprocess, "run", return_value=completed) as runner:
            backup_agent.read_timer_status("officechat-backup.timer")
        argv = runner.call_args.args[0]
        self.assertEqual(argv[:3], ["systemctl", "show", "officechat-backup.timer"])
        self.assertFalse(runner.call_args.kwargs.get("shell", False))

    def test_protocol_validation(self) -> None:
        protocol = backup_agent.AgentProtocol(self.inspector)
        request_id = str(uuid.uuid4())
        with self.assertRaises(backup_agent.AgentError) as mismatch:
            protocol.handle({"protocol_version": 2, "request_id": request_id, "operation": "status", "params": {}})
        self.assertEqual(mismatch.exception.code, "PROTOCOL_MISMATCH")
        with self.assertRaises(backup_agent.AgentError) as unknown:
            protocol.handle({"protocol_version": 1, "request_id": request_id, "operation": "delete", "params": {}})
        self.assertEqual(unknown.exception.code, "UNKNOWN_OPERATION")

    def test_job_protocol_rejects_client_commands_and_shell_arguments(self) -> None:
        manager = backup_agent.BackupJobManager(
            self.config,
            self.inspector,
            popen=lambda *_args, **_kwargs: MagicMock(wait=lambda: 0),
        )
        protocol = backup_agent.AgentProtocol(self.inspector, manager)
        request_id = str(uuid.uuid4())
        for params in (
            {"executable": "/bin/sh"},
            {"config_path": "/tmp/evil"},
            {"argv": [";touch", "/tmp/pwned"]},
        ):
            with self.assertRaises(backup_agent.AgentError) as raised:
                protocol.handle({
                    "protocol_version": 1,
                    "request_id": request_id,
                    "operation": "create_backup",
                    "params": params,
                })
            self.assertEqual(raised.exception.code, "INVALID_PARAMS")
        with self.assertRaises(backup_agent.AgentError) as top_level:
            protocol.handle({
                "protocol_version": 1,
                "request_id": request_id,
                "operation": "create_backup",
                "params": {},
                "executable": "/bin/sh",
            })
        self.assertEqual(top_level.exception.code, "INVALID_REQUEST")

    def test_create_job_uses_fixed_argv_without_shell_and_persists_safe_state(self) -> None:
        calls = []

        class Process:
            pid = 12345

            def wait(self, timeout=None):
                return 0

            def poll(self):
                return 0

        def popen(argv, **kwargs):
            calls.append((argv, kwargs))
            created = self.make_backup(
                "officechat-backup-20260805-120000Z",
                manifest={"timestamp": timestamp()},
            )
            (created / "SUCCESS").touch()
            self.config.status_file.write_text(json.dumps({
                "last_run": {"backup_id": created.name},
            }), encoding="utf-8")
            return Process()

        manager = backup_agent.BackupJobManager(self.config, self.inspector, popen=popen)
        accepted = manager.create_job(
            "create_backup", requested_by_user_id=ACTOR_USER_ID, requested_by_login=ACTOR_LOGIN
        )
        self.assertEqual(accepted["state"], "queued")
        result = self.wait_for_terminal(manager, accepted["job_id"])
        self.assertEqual(result["state"], "succeeded")
        self.assertEqual(result["backup_id"], "officechat-backup-20260805-120000Z")
        self.assertEqual(calls[0][0], list(backup_agent.BACKUP_COMMAND))
        self.assertFalse(calls[0][1]["shell"])
        self.assertEqual(calls[0][1]["env"], backup_agent.SAFE_JOB_ENVIRONMENT)
        state = (self.config.state_directory / "jobs.json").read_text(encoding="utf-8")
        self.assertLessEqual(len(state.encode()), backup_agent.JOB_HISTORY_MAX_BYTES)
        self.assertNotIn("password", state.lower())
        self.assertFalse(list(self.config.state_directory.glob(".jobs-*.tmp")))

    def test_backup_storage_error_finishes_job_without_starting_process(self) -> None:
        popen = MagicMock()
        manager = backup_agent.BackupJobManager(self.config, self.inspector, popen=popen)
        with patch.object(
            self.inspector,
            "completed_backup_ids",
            side_effect=backup_agent.AgentError("BACKUP_ROOT_UNAVAILABLE", "Backup storage is unavailable"),
        ):
            accepted = manager.create_job(
                "create_backup", requested_by_user_id=ACTOR_USER_ID, requested_by_login=ACTOR_LOGIN
            )
            result = self.wait_for_terminal(manager, accepted["job_id"])

        self.assertEqual(result["state"], "failed")
        self.assertEqual(result["last_error"], "JOB_START_FAILED")
        self.assertIsNone(manager.active_job())
        popen.assert_not_called()

    def test_verify_requires_completed_safe_backup_and_uses_fixed_prefix(self) -> None:
        directory = self.make_backup(manifest={"timestamp": timestamp()})
        manager = backup_agent.BackupJobManager(self.config, self.inspector)
        with self.assertRaises(backup_agent.AgentError) as incomplete:
            manager.create_job(
                "verify_backup",
                backup_id=directory.name,
                requested_by_user_id=ACTOR_USER_ID,
                requested_by_login=ACTOR_LOGIN,
            )
        self.assertEqual(incomplete.exception.code, "BACKUP_INCOMPLETE")
        (directory / "SUCCESS").touch()
        with self.assertRaises(backup_agent.AgentError):
            manager.create_job(
                "verify_backup",
                backup_id="../../etc/passwd",
                requested_by_user_id=ACTOR_USER_ID,
                requested_by_login=ACTOR_LOGIN,
            )
        calls = []
        process = MagicMock(pid=12345)
        process.wait.return_value = 0
        process.poll.return_value = 0
        verifying = backup_agent.BackupJobManager(
            self.config,
            self.inspector,
            popen=lambda argv, **kwargs: calls.append((argv, kwargs)) or process,
        )
        accepted = verifying.create_job(
            "verify_backup",
            backup_id=directory.name,
            requested_by_user_id=ACTOR_USER_ID,
            requested_by_login=ACTOR_LOGIN,
        )
        result = self.wait_for_terminal(verifying, accepted["job_id"])
        self.assertEqual(result["state"], "succeeded")
        self.assertEqual(calls[0][0], [*backup_agent.VERIFY_COMMAND_PREFIX, directory.name])
        self.assertFalse(calls[0][1]["shell"])

    def test_terminal_audit_claim_is_durable_idempotent_and_preserves_actor(self) -> None:
        directory = self.make_backup(manifest={"timestamp": timestamp()})
        (directory / "SUCCESS").touch()
        process = MagicMock(pid=12345)
        process.wait.return_value = 0
        process.poll.return_value = 0
        manager = backup_agent.BackupJobManager(
            self.config, self.inspector, popen=lambda *_args, **_kwargs: process
        )
        accepted = manager.create_job(
            "verify_backup",
            backup_id=directory.name,
            requested_by_user_id=ACTOR_USER_ID,
            requested_by_login=ACTOR_LOGIN,
        )
        self.wait_for_terminal(manager, accepted["job_id"])
        self.assertNotIn("requested_by_login", manager.get_job(accepted["job_id"]))

        claim = manager.claim_terminal_audit()
        self.assertEqual(claim["job"]["requested_by_user_id"], ACTOR_USER_ID)
        self.assertEqual(claim["job"]["requested_by_login"], ACTOR_LOGIN)
        self.assertIsNone(manager.claim_terminal_audit()["job"])
        completed = manager.complete_terminal_audit(accepted["job_id"], claim["claim_id"])
        self.assertIsNotNone(completed["audit_reconciled_at"])
        self.assertEqual(
            manager.complete_terminal_audit(accepted["job_id"], claim["claim_id"]), completed
        )

        restarted = backup_agent.BackupJobManager(self.config, self.inspector)
        self.assertIsNone(restarted.claim_terminal_audit()["job"])
        state = (self.config.state_directory / "jobs.json").read_text(encoding="utf-8")
        self.assertIn(ACTOR_LOGIN, state)
        self.assertNotIn("token", state.lower())
        self.assertNotIn("password", state.lower())

    def test_terminal_audit_claim_is_exclusive_and_can_be_released(self) -> None:
        process = MagicMock(pid=12345)
        process.wait.return_value = 7
        process.poll.return_value = 7
        manager = backup_agent.BackupJobManager(
            self.config, self.inspector, popen=lambda *_args, **_kwargs: process
        )
        accepted = manager.create_job(
            "create_backup", requested_by_user_id=ACTOR_USER_ID, requested_by_login=ACTOR_LOGIN
        )
        self.wait_for_terminal(manager, accepted["job_id"])

        with ThreadPoolExecutor(max_workers=2) as executor:
            claims = list(executor.map(lambda _value: manager.claim_terminal_audit(), range(2)))
        claimed = [claim for claim in claims if claim["job"] is not None]
        self.assertEqual(len(claimed), 1)
        first_claim = claimed[0]
        self.assertTrue(manager.release_terminal_audit(accepted["job_id"], first_claim["claim_id"])["released"])
        second_claim = manager.claim_terminal_audit()
        self.assertIsNotNone(second_claim["job"])
        self.assertNotEqual(first_claim["claim_id"], second_claim["claim_id"])
        with manager._lock:
            manager._jobs[-1]["audit_claimed_at"] = "2020-01-01T00:00:00+00:00"
            manager._save_state()
        recovered_claim = manager.claim_terminal_audit()
        self.assertIsNotNone(recovered_claim["job"])
        self.assertNotEqual(second_claim["claim_id"], recovered_claim["claim_id"])

        with self.assertRaises(backup_agent.AgentError) as unknown:
            manager.complete_terminal_audit(str(uuid.uuid4()), recovered_claim["claim_id"])
        self.assertEqual(unknown.exception.code, "JOB_NOT_FOUND")

    def test_audit_protocol_rejects_actor_spoofing_and_non_terminal_ack(self) -> None:
        release = threading.Event()

        class BlockingProcess:
            pid = 12345

            def wait(self, timeout=None):
                release.wait(timeout=2)
                return 0

            def poll(self):
                return None if not release.is_set() else 0

        manager = backup_agent.BackupJobManager(
            self.config, self.inspector, popen=lambda *_args, **_kwargs: BlockingProcess()
        )
        protocol = backup_agent.AgentProtocol(self.inspector, manager)
        accepted = protocol.handle({
            "protocol_version": 1,
            "request_id": str(uuid.uuid4()),
            "operation": "create_backup",
            "params": {"requested_by_user_id": ACTOR_USER_ID, "requested_by_login": ACTOR_LOGIN},
        })["data"]
        claim_id = str(uuid.uuid4())
        with self.assertRaises(backup_agent.AgentError) as running:
            manager.complete_terminal_audit(accepted["job_id"], claim_id)
        self.assertEqual(running.exception.code, "AUDIT_JOB_NOT_TERMINAL")
        with self.assertRaises(backup_agent.AgentError) as spoofed:
            protocol.handle({
                "protocol_version": 1,
                "request_id": str(uuid.uuid4()),
                "operation": "complete_job_audit",
                "params": {
                    "job_id": accepted["job_id"],
                    "claim_id": claim_id,
                    "requested_by_login": "attacker",
                },
            })
        self.assertEqual(spoofed.exception.code, "INVALID_PARAMS")
        release.set()
        self.wait_for_terminal(manager, accepted["job_id"])

    def test_corrupt_audit_state_is_discarded_safely(self) -> None:
        self.config.state_directory.mkdir(mode=0o700)
        (self.config.state_directory / "jobs.json").write_text(json.dumps({
            "version": backup_agent.JOB_HISTORY_VERSION,
            "jobs": [{
                "job_id": str(uuid.uuid4()),
                "operation": "create_backup",
                "state": "succeeded",
                "requested_at": timestamp(),
                "audit_claim_id": "not-a-uuid",
            }],
        }), encoding="utf-8")

        manager = backup_agent.BackupJobManager(self.config, self.inspector)
        self.assertIsNone(manager.active_job())
        self.assertIsNone(manager.claim_terminal_audit()["job"])

    def test_unreconciled_audit_history_is_never_evicted(self) -> None:
        self.config = replace(self.config, max_job_history=2)
        manager = backup_agent.BackupJobManager(self.config, self.inspector)
        template = {
            "operation": "create_backup",
            "state": "failed",
            "phase": "error",
            "backup_id": None,
            "requested_at": timestamp(),
            "started_at": timestamp(),
            "finished_at": timestamp(),
            "success": False,
            "exit_code": 1,
            "safe_message": "Backup failed",
            "last_error": "JOB_EXECUTION_FAILED",
            "requested_by_user_id": ACTOR_USER_ID,
            "requested_by_login": ACTOR_LOGIN,
            "audit_claim_id": None,
            "audit_claimed_at": None,
            "audit_reconciled_at": None,
        }
        reconciled_job_id = str(uuid.uuid4())
        pending_job_id = str(uuid.uuid4())
        manager._jobs = [
            {**template, "job_id": reconciled_job_id},
            {**template, "job_id": pending_job_id},
        ]
        manager._save_state()

        with self.assertRaises(backup_agent.AgentError) as full:
            manager.create_job(
                "create_backup",
                requested_by_user_id=ACTOR_USER_ID,
                requested_by_login=ACTOR_LOGIN,
            )
        self.assertEqual(full.exception.code, "AUDIT_BACKLOG_FULL")
        self.assertEqual(len(manager._jobs), 2)

        claim = manager.claim_terminal_audit()
        self.assertIsNotNone(claim["job"])
        self.assertTrue(
            manager.release_terminal_audit(claim["job"]["job_id"], claim["claim_id"])["released"]
        )

        manager._jobs[0]["audit_reconciled_at"] = timestamp()
        manager._save_state()

        accepted = manager.create_job(
            "create_backup",
            requested_by_user_id=ACTOR_USER_ID,
            requested_by_login=ACTOR_LOGIN,
        )
        self.assertEqual(len(manager._jobs), 2)
        self.assertNotIn(reconciled_job_id, {job["job_id"] for job in manager._jobs})
        self.assertIn(pending_job_id, {job["job_id"] for job in manager._jobs})
        self.wait_for_terminal(manager, accepted["job_id"])

    def test_lower_history_limit_preserves_unreconciled_jobs_on_restart(self) -> None:
        self.config = replace(self.config, max_job_history=3)
        manager = backup_agent.BackupJobManager(self.config, self.inspector)
        template = {
            "operation": "create_backup",
            "state": "failed",
            "phase": "error",
            "backup_id": None,
            "requested_at": timestamp(),
            "started_at": timestamp(),
            "finished_at": timestamp(),
            "success": False,
            "exit_code": 1,
            "safe_message": "Backup failed",
            "last_error": "JOB_EXECUTION_FAILED",
            "requested_by_user_id": ACTOR_USER_ID,
            "requested_by_login": ACTOR_LOGIN,
            "audit_claim_id": None,
            "audit_claimed_at": None,
            "audit_reconciled_at": None,
        }
        pending_job_id = str(uuid.uuid4())
        manager._jobs = [
            {**template, "job_id": pending_job_id},
            {**template, "job_id": str(uuid.uuid4()), "audit_reconciled_at": timestamp()},
            {**template, "job_id": str(uuid.uuid4()), "audit_reconciled_at": timestamp()},
        ]
        manager._save_state()

        self.config = replace(self.config, max_job_history=1)
        restarted = backup_agent.BackupJobManager(self.config, self.inspector)

        self.assertEqual([job["job_id"] for job in restarted._jobs], [pending_job_id])
        self.assertEqual(restarted.claim_terminal_audit()["job"]["job_id"], pending_job_id)

    def test_only_one_active_job_and_restart_marks_it_interrupted(self) -> None:
        release = threading.Event()

        class BlockingProcess:
            pid = 12345

            def wait(self, timeout=None):
                release.wait(timeout=2)
                return 0

            def poll(self):
                return None if not release.is_set() else 0

        manager = backup_agent.BackupJobManager(
            self.config, self.inspector, popen=lambda *_args, **_kwargs: BlockingProcess()
        )
        first = manager.create_job(
            "create_backup", requested_by_user_id=ACTOR_USER_ID, requested_by_login=ACTOR_LOGIN
        )
        for _ in range(100):
            if manager.active_job() and manager.active_job()["state"] == "running":
                break
            time.sleep(0.01)
        with self.assertRaises(backup_agent.AgentError) as conflict:
            manager.create_job(
                "create_backup", requested_by_user_id=ACTOR_USER_ID, requested_by_login=ACTOR_LOGIN
            )
        self.assertEqual(conflict.exception.code, "JOB_CONFLICT")
        release.set()
        self.wait_for_terminal(manager, first["job_id"])

        payload = json.loads((self.config.state_directory / "jobs.json").read_text(encoding="utf-8"))
        payload["jobs"][-1].update({"state": "running", "finished_at": None, "success": None})
        (self.config.state_directory / "jobs.json").write_text(json.dumps(payload), encoding="utf-8")
        restarted = backup_agent.BackupJobManager(self.config, self.inspector)
        recovered = restarted.get_job(first["job_id"])
        self.assertEqual(recovered["state"], "interrupted")
        self.assertIsNone(restarted.active_job())
        interrupted_claim = restarted.claim_terminal_audit()
        self.assertEqual(interrupted_claim["job"]["state"], "interrupted")
        self.assertEqual(interrupted_claim["job"]["requested_by_login"], ACTOR_LOGIN)

    def test_agent_config_is_allowlisted_owned_and_does_not_execute_shell(self) -> None:
        config_path = self.root / "agent.conf"
        config_path.write_text(
            "\n".join((
                f"BACKUP_ROOT={self.backup_root}",
                f"STATUS_DIRECTORY={self.status_dir}",
                f"STATUS_FILE={self.config.status_file}",
                f"BACKUP_CONFIG_PATH={self.backup_config}",
                f"SOCKET_PATH={self.config.socket_path}",
                "SOCKET_GROUP=officechat-backup",
                "TIMER_UNIT=officechat-backup.timer",
            )),
            encoding="utf-8",
        )
        os.chmod(config_path, 0o600)
        loaded = backup_agent.load_agent_config(config_path, expected_uid=os.getuid())
        self.assertEqual(loaded.backup_root, self.backup_root)

        config_path.write_text("UNKNOWN_KEY=$(touch /tmp/never-run)\n", encoding="utf-8")
        with self.assertRaisesRegex(ValueError, "Unknown"):
            backup_agent.load_agent_config(config_path, expected_uid=os.getuid())

        config_path.write_text(f"BACKUP_ROOT={self.backup_root}\n", encoding="utf-8")
        os.chmod(config_path, 0o666)
        with self.assertRaisesRegex(ValueError, "0600 or 0640"):
            backup_agent.load_agent_config(config_path, expected_uid=os.getuid())

    def test_socket_path_rejects_symlink_and_server_is_not_world_accessible(self) -> None:
        target = self.runtime_dir / "target"
        target.touch()
        try:
            self.config.socket_path.symlink_to(target)
        except OSError as exc:
            self.skipTest(str(exc))
        with self.assertRaisesRegex(RuntimeError, "unsafe"):
            backup_agent._prepare_socket_path(self.config)
        self.config.socket_path.unlink()

        server = backup_agent.BackupAgentServer(self.config, self.inspector)
        try:
            os.chmod(self.config.socket_path, 0o660)
            self.assertEqual(os.stat(self.config.socket_path).st_mode & 0o777, 0o660)
        finally:
            server.server_close()
            self.config.socket_path.unlink(missing_ok=True)

    def test_invalid_json_and_oversized_request_over_socket(self) -> None:
        server = backup_agent.BackupAgentServer(self.config, self.inspector)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            for raw, expected in ((b"{\n", "INVALID_JSON"), (b"x" * 1025 + b"\n", "REQUEST_TOO_LARGE")):
                with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as client:
                    client.connect(str(self.config.socket_path))
                    client.sendall(raw)
                    response = json.loads(client.makefile("rb").readline())
                self.assertEqual(response["error"]["code"], expected)
        finally:
            server.shutdown()
            server.server_close()
            thread.join(timeout=2)


if __name__ == "__main__":
    unittest.main()
