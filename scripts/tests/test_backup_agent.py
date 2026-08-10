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


class FakeExecutor:
    def __init__(self, *, result=0, error=None, on_run=None, release=None):
        self.result = result
        self.error = error
        self.on_run = on_run
        self.release = release
        self.calls = []

    def run(self, operation, backup_id, **kwargs):
        self.calls.append((operation, backup_id, kwargs))
        if self.on_run:
            self.on_run()
        if self.release:
            self.release.wait(timeout=2)
        if self.error:
            raise self.error
        return self.result


class FakeSystemctlRunner:
    def __init__(
        self,
        target_unit,
        *,
        exit_code=0,
        scheduled_active=False,
        target_active=False,
        active_executor_units=(),
        never_finishes=False,
        reset_failed_returncode=0,
        stale_polls_after_start=0,
        stale_forever_after_start=False,
        stale_after_new_once=False,
    ):
        self.target_unit = target_unit
        self.exit_code = exit_code
        self.scheduled_active = scheduled_active
        self.target_active = target_active
        self.active_executor_units = set(active_executor_units)
        if target_active:
            self.active_executor_units.add(target_unit)
        self.never_finishes = never_finishes
        self.reset_failed_returncode = reset_failed_returncode
        self.stale_polls_after_start = stale_polls_after_start
        self.stale_forever_after_start = stale_forever_after_start
        self.stale_after_new_once = stale_after_new_once
        self.calls = []
        self.start_count = 0
        self.polls_since_start = 0
        self.current_run_exit_code = None

    @staticmethod
    def _completed(argv, stdout="", returncode=0):
        return backup_agent.subprocess.CompletedProcess(argv, returncode, stdout, "")

    def __call__(self, argv, **kwargs):
        self.calls.append((argv, kwargs))
        action = argv[1]
        if action == "list-units":
            lines = [
                f"{unit} loaded active running OfficeChat backup verification"
                for unit in sorted(self.active_executor_units)
                if unit.startswith(backup_agent.VERIFY_EXECUTOR_UNIT_PREFIX)
            ]
            return self._completed(argv, "\n".join(lines) + ("\n" if lines else ""))
        if action == "show":
            unit = argv[2]
            if unit == backup_agent.SCHEDULED_BACKUP_UNIT:
                active = "active" if self.scheduled_active else "inactive"
                return self._completed(argv, f"LoadState=loaded\nActiveState={active}\nInvocationID=scheduled\n")
            if unit != self.target_unit:
                if unit == backup_agent.CREATE_EXECUTOR_UNIT:
                    active = "active" if unit in self.active_executor_units else "inactive"
                    return self._completed(
                        argv,
                        f"LoadState=loaded\nActiveState={active}\nSubState=dead\nResult=success\n"
                        "ExecMainCode=1\nExecMainStatus=0\nExecMainStartTimestampMonotonic=100\n"
                        "InvocationID=old-create\n",
                    )
                return self._completed(argv, "LoadState=not-found\n", 1)
            if self.start_count == 0:
                active = "active" if unit in self.active_executor_units else "inactive"
                return self._completed(
                    argv,
                    f"LoadState=loaded\nActiveState={active}\nSubState=dead\nResult=success\n"
                    "ExecMainCode=1\nExecMainStatus=0\nExecMainStartTimestampMonotonic=100\n"
                    "InvocationID=old\n",
                )
            stale_status = (
                "LoadState=loaded\nActiveState=inactive\nSubState=dead\nResult=success\n"
                "ExecMainCode=1\nExecMainStatus=0\nExecMainStartTimestampMonotonic=100\n"
                "InvocationID=old\n"
            )
            if self.stale_forever_after_start:
                return self._completed(argv, stale_status)
            if self.polls_since_start < self.stale_polls_after_start:
                self.polls_since_start += 1
                return self._completed(argv, stale_status)
            relative_poll = self.polls_since_start - self.stale_polls_after_start
            invocation = f"new-{self.start_count}"
            if self.stale_after_new_once and relative_poll == 1:
                self.polls_since_start += 1
                return self._completed(argv, stale_status)
            if self.never_finishes or relative_poll == 0:
                self.polls_since_start += 1
                return self._completed(
                    argv,
                    "LoadState=loaded\nActiveState=activating\nSubState=start\nResult=success\n"
                    f"ExecMainCode=0\nExecMainStatus=0\nExecMainStartTimestampMonotonic={100 + self.start_count}\n"
                    f"InvocationID={invocation}\n",
                )
            exit_code = self.current_run_exit_code
            result = "success" if exit_code == 0 else "exit-code"
            active = "inactive" if exit_code == 0 else "failed"
            return self._completed(
                argv,
                f"LoadState=loaded\nActiveState={active}\nSubState=dead\nResult={result}\n"
                f"ExecMainCode=1\nExecMainStatus={exit_code}\n"
                f"ExecMainStartTimestampMonotonic={100 + self.start_count}\nInvocationID={invocation}\n",
            )
        if action == "reset-failed":
            return self._completed(argv, returncode=self.reset_failed_returncode)
        if action == "start":
            self.start_count += 1
            self.polls_since_start = 0
            self.current_run_exit_code = self.exit_code
        return self._completed(argv)


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
        self.assertEqual(argv[:3], [backup_agent.SYSTEMCTL_PATH, "show", "officechat-backup.timer"])
        self.assertFalse(runner.call_args.kwargs.get("shell", False))

    def test_systemd_executor_uses_only_fixed_create_unit_and_no_docker(self) -> None:
        runner = FakeSystemctlRunner(backup_agent.CREATE_EXECUTOR_UNIT)
        executor = backup_agent.SystemdJobExecutor(runner=runner, sleep=lambda _delay: None)

        result = executor.run(
            "create_backup",
            None,
            timeout_seconds=60,
            stop_event=threading.Event(),
        )
        repeated = executor.run(
            "create_backup",
            None,
            timeout_seconds=60,
            stop_event=threading.Event(),
        )

        self.assertEqual(result, 0)
        self.assertEqual(repeated, 0)
        argv_calls = [call[0] for call in runner.calls]
        self.assertIn(
            [backup_agent.SYSTEMCTL_PATH, "start", "--no-block", backup_agent.CREATE_EXECUTOR_UNIT],
            argv_calls,
        )
        self.assertFalse(any("docker" in argument for argv in argv_calls for argument in argv))
        self.assertTrue(all(argv[0] == backup_agent.SYSTEMCTL_PATH for argv in argv_calls))
        self.assertTrue(all(call[1]["shell"] is False for call in runner.calls))
        self.assertEqual(
            argv_calls.count(
                [backup_agent.SYSTEMCTL_PATH, "start", "--no-block", backup_agent.CREATE_EXECUTOR_UNIT]
            ),
            2,
        )

    def test_systemd_executor_builds_only_validated_verify_unit(self) -> None:
        backup_id = "officechat-backup-20260804-120000Z"
        unit = f"{backup_agent.VERIFY_EXECUTOR_UNIT_PREFIX}{backup_id}.service"
        runner = FakeSystemctlRunner(unit)
        executor = backup_agent.SystemdJobExecutor(runner=runner, sleep=lambda _delay: None)

        for _attempt in range(2):
            self.assertEqual(
                executor.run(
                    "verify_backup",
                    backup_id,
                    timeout_seconds=60,
                    stop_event=threading.Event(),
                ),
                0,
            )
        self.assertIn(
            [backup_agent.SYSTEMCTL_PATH, "start", "--no-block", unit],
            [call[0] for call in runner.calls],
        )
        self.assertEqual(
            [call[0] for call in runner.calls].count(
                [backup_agent.SYSTEMCTL_PATH, "start", "--no-block", unit]
            ),
            2,
        )
        for invalid in ("../../etc/passwd", "officechat-backup-20260804-120000Z;reboot", "bad\n.service"):
            with self.subTest(invalid=invalid), self.assertRaises(backup_agent.AgentError) as raised:
                backup_agent.executor_unit_name("verify_backup", invalid)
            self.assertEqual(raised.exception.code, "INVALID_BACKUP_ID")

    def test_systemd_executor_rejects_arbitrary_systemctl_commands_and_units(self) -> None:
        runner = MagicMock()
        executor = backup_agent.SystemdJobExecutor(runner=runner)

        rejected = (
            ("enable", backup_agent.CREATE_EXECUTOR_UNIT),
            ("reset-failed", backup_agent.CREATE_EXECUTOR_UNIT),
            ("start", "--no-block", "ssh.service"),
            ("stop", backup_agent.SCHEDULED_BACKUP_UNIT),
            ("show", "officechat-backup-verify@../../etc/passwd.service", "--no-pager"),
            ("list-units", "--type=service", "officechat-backup-verify@evil*.service"),
            ("set-property", backup_agent.CREATE_EXECUTOR_UNIT, "Environment=EVIL=1"),
        )
        for arguments in rejected:
            with self.subTest(arguments=arguments), self.assertRaises(backup_agent.AgentError) as raised:
                executor._systemctl(*arguments)
            self.assertEqual(raised.exception.code, "EXECUTOR_UNAVAILABLE")
        runner.assert_not_called()

    def test_systemd_executor_blocks_cross_class_jobs_left_running_after_agent_restart(self) -> None:
        backup_id = "officechat-backup-20260804-120000Z"
        verify_unit = f"{backup_agent.VERIFY_EXECUTOR_UNIT_PREFIX}{backup_id}.service"
        cases = (
            ("create_backup", None, (verify_unit,)),
            ("verify_backup", backup_id, (backup_agent.CREATE_EXECUTOR_UNIT,)),
            (
                "verify_backup",
                backup_id,
                (f"{backup_agent.VERIFY_EXECUTOR_UNIT_PREFIX}officechat-backup-20260803-120000Z.service",),
            ),
        )
        for operation, requested_backup_id, active_units in cases:
            unit = backup_agent.executor_unit_name(operation, requested_backup_id)
            runner = FakeSystemctlRunner(unit, active_executor_units=active_units)
            executor = backup_agent.SystemdJobExecutor(runner=runner)
            with self.subTest(operation=operation, active_units=active_units), self.assertRaises(
                backup_agent.AgentError
            ) as raised:
                executor.run(
                    operation,
                    requested_backup_id,
                    timeout_seconds=60,
                    stop_event=threading.Event(),
                )
            self.assertEqual(raised.exception.code, "BACKUP_BUSY")
            self.assertFalse(any(call[0][1] == "start" for call in runner.calls))

    def test_systemd_executor_can_succeed_after_previous_failed_oneshot(self) -> None:
        cases = (
            ("create_backup", None, "BACKUP_EXECUTION_FAILED"),
            ("verify_backup", "officechat-backup-20260804-120000Z", "VERIFY_FAILED"),
        )
        for operation, backup_id, error_code in cases:
            unit = backup_agent.executor_unit_name(operation, backup_id)
            runner = FakeSystemctlRunner(unit, exit_code=1)
            executor = backup_agent.SystemdJobExecutor(runner=runner, sleep=lambda _delay: None)

            with self.subTest(operation=operation), self.assertRaises(backup_agent.AgentError) as failed:
                executor.run(operation, backup_id, timeout_seconds=60, stop_event=threading.Event())
            self.assertEqual(failed.exception.code, error_code)

            runner.exit_code = 0
            self.assertEqual(
                executor.run(operation, backup_id, timeout_seconds=60, stop_event=threading.Event()),
                0,
            )
            argv_calls = [call[0] for call in runner.calls]
            self.assertEqual(
                argv_calls.count([backup_agent.SYSTEMCTL_PATH, "start", "--no-block", unit]),
                2,
            )
            self.assertFalse(any(call[1] == "reset-failed" for call in argv_calls))

    def test_systemd_executor_starts_unloaded_static_create_unit_without_reset_failed(self) -> None:
        runner = FakeSystemctlRunner(
            backup_agent.CREATE_EXECUTOR_UNIT,
            reset_failed_returncode=1,
        )
        executor = backup_agent.SystemdJobExecutor(runner=runner, sleep=lambda _delay: None)

        self.assertEqual(
            executor.run("create_backup", None, timeout_seconds=60, stop_event=threading.Event()),
            0,
        )
        argv_calls = [call[0] for call in runner.calls]
        self.assertIn(
            [backup_agent.SYSTEMCTL_PATH, "start", "--no-block", backup_agent.CREATE_EXECUTOR_UNIT],
            argv_calls,
        )
        self.assertFalse(any(call[1] == "reset-failed" for call in argv_calls))

    def test_systemd_executor_starts_unloaded_verify_instance_without_reset_failed(self) -> None:
        backup_id = "officechat-backup-20260804-120000Z"
        unit = f"{backup_agent.VERIFY_EXECUTOR_UNIT_PREFIX}{backup_id}.service"
        runner = FakeSystemctlRunner(unit, reset_failed_returncode=1)
        executor = backup_agent.SystemdJobExecutor(runner=runner, sleep=lambda _delay: None)

        self.assertEqual(
            executor.run("verify_backup", backup_id, timeout_seconds=60, stop_event=threading.Event()),
            0,
        )
        argv_calls = [call[0] for call in runner.calls]
        self.assertIn([backup_agent.SYSTEMCTL_PATH, "start", "--no-block", unit], argv_calls)
        self.assertFalse(any(call[1] == "reset-failed" for call in argv_calls))

    def test_systemd_executor_never_accepts_stale_success_as_new_job(self) -> None:
        ticks = iter((0.0, 0.0, 2.0))
        runner = FakeSystemctlRunner(
            backup_agent.CREATE_EXECUTOR_UNIT,
            stale_forever_after_start=True,
        )
        executor = backup_agent.SystemdJobExecutor(
            runner=runner,
            sleep=lambda _delay: None,
            monotonic=lambda: next(ticks),
        )

        with self.assertRaises(backup_agent.AgentError) as raised:
            executor.run("create_backup", None, timeout_seconds=1, stop_event=threading.Event())
        self.assertEqual(raised.exception.code, "EXECUTOR_TIMEOUT")
        self.assertIn(
            [backup_agent.SYSTEMCTL_PATH, "stop", backup_agent.CREATE_EXECUTOR_UNIT],
            [call[0] for call in runner.calls],
        )

    def test_systemd_executor_ignores_stale_terminal_after_new_invocation_seen(self) -> None:
        runner = FakeSystemctlRunner(
            backup_agent.CREATE_EXECUTOR_UNIT,
            stale_after_new_once=True,
        )
        executor = backup_agent.SystemdJobExecutor(runner=runner, sleep=lambda _delay: None)

        self.assertEqual(
            executor.run("create_backup", None, timeout_seconds=60, stop_event=threading.Event()),
            0,
        )
        target_shows = [
            call[0]
            for call in runner.calls
            if call[0][1:3] == ["show", backup_agent.CREATE_EXECUTOR_UNIT]
        ]
        self.assertGreaterEqual(len(target_shows), 4)

    def test_systemd_executor_classifies_busy_failure_unavailable_timeout_and_interrupt(self) -> None:
        cases = (
            ("create_backup", None, 75, "BACKUP_BUSY"),
            ("create_backup", None, 1, "BACKUP_EXECUTION_FAILED"),
            ("verify_backup", "officechat-backup-20260804-120000Z", 1, "VERIFY_FAILED"),
        )
        for operation, backup_id, exit_code, expected in cases:
            unit = backup_agent.executor_unit_name(operation, backup_id)
            executor = backup_agent.SystemdJobExecutor(
                runner=FakeSystemctlRunner(unit, exit_code=exit_code), sleep=lambda _delay: None
            )
            with self.subTest(expected=expected), self.assertRaises(backup_agent.AgentError) as raised:
                executor.run(operation, backup_id, timeout_seconds=60, stop_event=threading.Event())
            self.assertEqual(raised.exception.code, expected)

        busy = backup_agent.SystemdJobExecutor(
            runner=FakeSystemctlRunner(backup_agent.CREATE_EXECUTOR_UNIT, scheduled_active=True)
        )
        with self.assertRaises(backup_agent.AgentError) as scheduled:
            busy.run("create_backup", None, timeout_seconds=60, stop_event=threading.Event())
        self.assertEqual(scheduled.exception.code, "BACKUP_BUSY")

        executor_active = backup_agent.SystemdJobExecutor(
            runner=FakeSystemctlRunner(backup_agent.CREATE_EXECUTOR_UNIT, target_active=True)
        )
        with self.assertRaises(backup_agent.AgentError) as active:
            executor_active.run("create_backup", None, timeout_seconds=60, stop_event=threading.Event())
        self.assertEqual(active.exception.code, "BACKUP_BUSY")

        unavailable = backup_agent.SystemdJobExecutor(runner=MagicMock(side_effect=FileNotFoundError))
        with self.assertRaises(backup_agent.AgentError) as missing:
            unavailable.run("create_backup", None, timeout_seconds=60, stop_event=threading.Event())
        self.assertEqual(missing.exception.code, "EXECUTOR_UNAVAILABLE")

        ticks = iter((0.0, 0.0, 2.0, 2.0))
        timeout_runner = FakeSystemctlRunner(backup_agent.CREATE_EXECUTOR_UNIT, never_finishes=True)
        timed = backup_agent.SystemdJobExecutor(
            runner=timeout_runner,
            sleep=lambda _delay: None,
            monotonic=lambda: next(ticks),
        )
        with self.assertRaises(backup_agent.AgentError) as timeout:
            timed.run("create_backup", None, timeout_seconds=1, stop_event=threading.Event())
        self.assertEqual(timeout.exception.code, "EXECUTOR_TIMEOUT")
        self.assertIn(
            [backup_agent.SYSTEMCTL_PATH, "stop", backup_agent.CREATE_EXECUTOR_UNIT],
            [call[0] for call in timeout_runner.calls],
        )

        interrupted_runner = FakeSystemctlRunner(backup_agent.CREATE_EXECUTOR_UNIT)
        interrupted = backup_agent.SystemdJobExecutor(
            runner=interrupted_runner, sleep=lambda _delay: None
        )
        stop_event = threading.Event()
        stop_event.set()
        with self.assertRaises(backup_agent.AgentError) as stopped:
            interrupted.run("create_backup", None, timeout_seconds=60, stop_event=stop_event)
        self.assertEqual(stopped.exception.code, "JOB_INTERRUPTED")
        self.assertNotIn(
            [backup_agent.SYSTEMCTL_PATH, "stop", backup_agent.CREATE_EXECUTOR_UNIT],
            [call[0] for call in interrupted_runner.calls],
        )

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
            executor=FakeExecutor(),
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

    def test_create_job_uses_fixed_executor_and_persists_safe_state(self) -> None:
        def publish_backup():
            created = self.make_backup(
                "officechat-backup-20260805-120000Z",
                manifest={"timestamp": timestamp()},
            )
            (created / "SUCCESS").touch()
            self.config.status_file.write_text(json.dumps({
                "last_run": {"backup_id": created.name},
            }), encoding="utf-8")

        executor = FakeExecutor(on_run=publish_backup)
        manager = backup_agent.BackupJobManager(self.config, self.inspector, executor=executor)
        accepted = manager.create_job(
            "create_backup", requested_by_user_id=ACTOR_USER_ID, requested_by_login=ACTOR_LOGIN
        )
        self.assertEqual(accepted["state"], "queued")
        result = self.wait_for_terminal(manager, accepted["job_id"])
        self.assertEqual(result["state"], "succeeded")
        self.assertEqual(result["backup_id"], "officechat-backup-20260805-120000Z")
        self.assertEqual(executor.calls[0][0:2], ("create_backup", None))
        state = (self.config.state_directory / "jobs.json").read_text(encoding="utf-8")
        self.assertLessEqual(len(state.encode()), backup_agent.JOB_HISTORY_MAX_BYTES)
        self.assertNotIn("password", state.lower())
        self.assertFalse(list(self.config.state_directory.glob(".jobs-*.tmp")))

    def test_backup_storage_error_finishes_job_without_starting_process(self) -> None:
        executor = MagicMock()
        manager = backup_agent.BackupJobManager(self.config, self.inspector, executor=executor)
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
        self.assertEqual(result["last_error"], "BACKUP_EXECUTION_FAILED")
        self.assertIsNone(manager.active_job())
        executor.run.assert_not_called()

    def test_verify_requires_completed_safe_backup_and_uses_fixed_prefix(self) -> None:
        directory = self.make_backup(manifest={"timestamp": timestamp()})
        manager = backup_agent.BackupJobManager(self.config, self.inspector, executor=FakeExecutor())
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
        executor = FakeExecutor()
        verifying = backup_agent.BackupJobManager(
            self.config,
            self.inspector,
            executor=executor,
        )
        accepted = verifying.create_job(
            "verify_backup",
            backup_id=directory.name,
            requested_by_user_id=ACTOR_USER_ID,
            requested_by_login=ACTOR_LOGIN,
        )
        result = self.wait_for_terminal(verifying, accepted["job_id"])
        self.assertEqual(result["state"], "succeeded")
        self.assertEqual(executor.calls[0][0:2], ("verify_backup", directory.name))

    def test_terminal_audit_claim_is_durable_idempotent_and_preserves_actor(self) -> None:
        directory = self.make_backup(manifest={"timestamp": timestamp()})
        (directory / "SUCCESS").touch()
        manager = backup_agent.BackupJobManager(
            self.config, self.inspector, executor=FakeExecutor()
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
        manager = backup_agent.BackupJobManager(
            self.config,
            self.inspector,
            executor=FakeExecutor(error=backup_agent.AgentError("BACKUP_EXECUTION_FAILED", "failed")),
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

        manager = backup_agent.BackupJobManager(
            self.config, self.inspector, executor=FakeExecutor(release=release)
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
        manager = backup_agent.BackupJobManager(self.config, self.inspector, executor=FakeExecutor())
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
        backup = self.make_backup(manifest={"timestamp": timestamp()})
        (backup / "SUCCESS").touch()

        manager = backup_agent.BackupJobManager(
            self.config, self.inspector, executor=FakeExecutor(release=release)
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
        with self.assertRaises(backup_agent.AgentError) as verify_conflict:
            manager.create_job(
                "verify_backup",
                backup_id=backup.name,
                requested_by_user_id=ACTOR_USER_ID,
                requested_by_login=ACTOR_LOGIN,
            )
        self.assertEqual(verify_conflict.exception.code, "JOB_CONFLICT")
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

        verify_release = threading.Event()
        verifying = backup_agent.BackupJobManager(
            replace(self.config, state_directory=self.root / "verify-state"),
            self.inspector,
            executor=FakeExecutor(release=verify_release),
        )
        verify_job = verifying.create_job(
            "verify_backup",
            backup_id=backup.name,
            requested_by_user_id=ACTOR_USER_ID,
            requested_by_login=ACTOR_LOGIN,
        )
        for _ in range(100):
            if verifying.active_job() and verifying.active_job()["state"] == "verifying":
                break
            time.sleep(0.01)
        with self.assertRaises(backup_agent.AgentError) as create_conflict:
            verifying.create_job(
                "create_backup",
                requested_by_user_id=ACTOR_USER_ID,
                requested_by_login=ACTOR_LOGIN,
            )
        self.assertEqual(create_conflict.exception.code, "JOB_CONFLICT")
        verify_release.set()
        self.wait_for_terminal(verifying, verify_job["job_id"])

    def test_agent_stop_interrupts_observation_without_stopping_executor(self) -> None:
        runner = FakeSystemctlRunner(backup_agent.CREATE_EXECUTOR_UNIT, never_finishes=True)
        manager = backup_agent.BackupJobManager(
            self.config,
            self.inspector,
            executor=backup_agent.SystemdJobExecutor(runner=runner, poll_interval_seconds=0.01),
        )
        job = manager.create_job(
            "create_backup",
            requested_by_user_id=ACTOR_USER_ID,
            requested_by_login=ACTOR_LOGIN,
        )
        for _ in range(100):
            if any(call[0][1:3] == ["start", "--no-block"] for call in runner.calls):
                break
            time.sleep(0.01)

        manager.stop()
        terminal = self.wait_for_terminal(manager, job["job_id"])

        self.assertEqual(terminal["state"], "interrupted")
        self.assertEqual(terminal["last_error"], "JOB_INTERRUPTED")
        self.assertNotIn(
            [backup_agent.SYSTEMCTL_PATH, "stop", backup_agent.CREATE_EXECUTOR_UNIT],
            [call[0] for call in runner.calls],
        )
        with self.assertRaises(backup_agent.AgentError) as stopping:
            manager.create_job(
                "create_backup",
                requested_by_user_id=ACTOR_USER_ID,
                requested_by_login=ACTOR_LOGIN,
            )
        self.assertEqual(stopping.exception.code, "JOB_INTERRUPTED")

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
