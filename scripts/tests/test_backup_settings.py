from __future__ import annotations

import importlib.util
import json
import tempfile
import unittest
from dataclasses import replace
from pathlib import Path
from unittest.mock import patch
from types import SimpleNamespace


SPEC = importlib.util.spec_from_file_location(
    "officechat_backup_settings", Path(__file__).resolve().parents[1] / "backup_settings.py"
)
assert SPEC and SPEC.loader
settings = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(settings)
AGENT_SPEC = importlib.util.spec_from_file_location(
    "officechat_settings_agent_contract", Path(__file__).resolve().parents[1] / "backup_agent.py"
)
assert AGENT_SPEC and AGENT_SPEC.loader
import sys
agent = importlib.util.module_from_spec(AGENT_SPEC)
sys.modules[AGENT_SPEC.name] = agent
AGENT_SPEC.loader.exec_module(agent)


def request(kind="local", enabled=False):
    return {
        "request_id": "11111111-1111-4111-8111-111111111111",
        "state": "queued",
        "requested_at": "2026-10-03T00:00:00+00:00",
        "destination": {"kind": kind},
        "schedule": {"enabled": enabled, "days": ["Mon", "Wed"], "time": "02:30"},
    }


class SettingsTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        root = Path(self.temp.name)
        self.patches = [
            patch.object(settings, "CONFIG", root / "backup.conf"),
            patch.object(settings, "TIMER_OVERRIDE", root / "timer.conf"),
            patch.object(settings, "BACKUP_STATUS", root / "latest.json"),
            patch.object(settings, "REQUEST_DIR", root / "settings"),
            patch.object(settings, "MOUNTPOINT", root / "mount"),
            patch.object(settings, "MOUNT_UNIT", root / "mount.service"),
            patch.object(settings, "CREDENTIALS", root / "credentials"),
            patch.object(settings, "run"),
        ]
        for item in self.patches:
            item.start()
            self.addCleanup(item.stop)
        settings.CONFIG.write_text("BACKUP_ROOT=/var/backups/officechat/production\nOFFSITE_ROOT=\nREQUIRE_OFFSITE=no\n")
        settings.CONFIG.chmod(0o600)
        settings.REQUEST_DIR.mkdir(mode=0o700)
        settings.BACKUP_STATUS.write_text(json.dumps({
            "last_success": {"verification_status": "passed", "offsite_status": "not_configured"}
        }))
        settings.BACKUP_STATUS.chmod(0o600)

    def test_rejects_untrusted_mount_options_and_password_newlines(self):
        candidate = request("nfs")
        candidate["destination"] = {"kind": "nfs", "host": "nas", "export": "/safe", "version": "4.1",
                                    "require_offsite": True, "options": "exec"}
        with self.assertRaises(ValueError):
            settings.validated(candidate)
        candidate["destination"] = {"kind": "smb", "host": "fileserver", "share": "chat", "domain": "AD",
                                    "username": "backup", "password": "secret\nother=value", "require_offsite": True}
        with self.assertRaises(ValueError):
            settings.validated(candidate)

    def write_mount(self):
        unit, _ = settings.mount_file({"kind": "smb", "host": "192.168.1.100", "share": "backup_share",
            "directory": "OfficeChat", "username": "backup", "password": "secret", "domain": ""})
        settings.MOUNT_UNIT.write_bytes(unit)
        settings.MOUNT_UNIT.chmod(0o644)
        settings.CONFIG.write_text(f"BACKUP_ROOT=/var/backups/officechat/production\nOFFSITE_ROOT={settings.MOUNTPOINT}\nREQUIRE_OFFSITE=no\n")

    def test_reconnect_checks_mount_without_changing_schedule_or_config(self):
        self.write_mount()
        before = settings.CONFIG.read_bytes()
        with patch.object(settings, "check_mounted_destination") as probe:
            settings.apply(request("reconnect", enabled=True))
        probe.assert_called_once_with(before)
        self.assertEqual(settings.CONFIG.read_bytes(), before)
        self.assertFalse(settings.TIMER_OVERRIDE.exists())
        self.assertEqual(settings.run.call_args_list[-1].args, (settings.SYSTEMCTL, "start", settings.UNIT_NAME))
        self.assertFalse(any(settings.TIMER_NAME in call.args for call in settings.run.call_args_list))

    def test_reconnect_does_not_persist_request_schedule(self):
        candidate = request("reconnect", enabled=False)
        current = settings.REQUEST_DIR / "current.json"
        settings.atomic_write(current, json.dumps({"destination": {"kind": "smb"}, "schedule": {"enabled": True}}).encode())
        original = current.read_bytes()
        path = settings.REQUEST_DIR / f"{candidate['request_id']}.json"
        settings.atomic_write(path, json.dumps(candidate).encode())
        with patch.object(settings, "apply"), patch.object(settings, "Path", wraps=Path) as paths:
            paths.side_effect = lambda value: (Path(self.temp.name) / "backup.lock" if value == "/run/lock/officechat/backup.lock" else
                Path(self.temp.name) / "release.lock" if value == "/tmp/officechat-release.lock" else Path(value))
            self.assertEqual(settings.main(candidate["request_id"]), 0)
        self.assertEqual(current.read_bytes(), original)

    def test_reconnect_failure_preserves_existing_files(self):
        self.write_mount()
        before = settings.CONFIG.read_bytes(), settings.MOUNT_UNIT.read_bytes()
        with patch.object(settings, "run", side_effect=RuntimeError("mount failed")), self.assertRaises(RuntimeError):
            settings.apply(request("reconnect"))
        self.assertEqual((settings.CONFIG.read_bytes(), settings.MOUNT_UNIT.read_bytes()), before)
        self.assertFalse(settings.TIMER_OVERRIDE.exists())

    def test_reconnect_rejects_missing_or_untrusted_mount(self):
        with self.assertRaises(ValueError):
            settings.apply(request("reconnect"))
        self.write_mount()
        settings.MOUNT_UNIT.write_text("[Mount]\nWhat=//host/share\nWhere=/other\nType=cifs\n")
        with self.assertRaises(ValueError):
            settings.apply(request("reconnect"))
        settings.run.assert_not_called()

    def test_network_wait_retries_missing_route_and_stops_at_deadline(self):
        self.write_mount()
        with patch.object(settings.socket, "getaddrinfo", side_effect=OSError("no network")), \
                patch.object(settings.time, "monotonic", side_effect=[0, 0, 0, 61]), \
                patch.object(settings.time, "sleep") as sleep:
            with self.assertRaisesRegex(settings.SettingsError, "NETWORK_ROUTE_UNAVAILABLE"):
                settings.wait_for_mount_route()
        sleep.assert_called_once_with(1)

    def test_network_wait_handles_nfs_source(self):
        unit, _ = settings.mount_file({"kind": "nfs", "host": "nas", "export": "/backups/chat", "version": "4.1"})
        settings.MOUNT_UNIT.write_bytes(unit)
        settings.MOUNT_UNIT.chmod(0o644)
        self.assertEqual(settings.managed_mount_host(), "nas")

    def test_network_wait_accepts_kernel_route_without_sending_data(self):
        self.write_mount()
        from unittest.mock import MagicMock
        probe = MagicMock()
        probe.__enter__.return_value = probe
        probe.getsockname.return_value = ("192.168.0.157", 12345)
        with patch.object(settings.socket, "getaddrinfo", return_value=[(2, 2, 17, "", ("192.168.1.100", 9))]), \
                patch.object(settings.socket, "socket", return_value=probe):
            settings.wait_for_mount_route()
        probe.connect.assert_called_once_with(("192.168.1.100", 9))
        probe.send.assert_not_called()
        probe.sendto.assert_not_called()

    def test_smb_credentials_not_in_mount_unit(self):
        candidate = {"kind": "smb", "host": "fileserver", "share": "chat", "domain": "AD",
                     "directory": "OfficeChat", "username": "backup", "password": "secret123", "require_offsite": True}
        settings.validated({**request(), "destination": candidate})
        unit, credentials = settings.mount_file(candidate)
        self.assertNotIn(b"secret123", unit)
        self.assertIn(b"credentials=", unit)
        self.assertIn(b"What=//fileserver/chat/OfficeChat\n", unit)
        self.assertIn(b"password=secret123", credentials)

    def test_smb_subdirectory_rejects_traversal_and_mount_option_injection(self):
        base = {"kind": "smb", "host": "fileserver", "share": "chat", "domain": "",
                "username": "backup", "password": "secret", "require_offsite": False}
        for directory in ("../other", "a/../other", "/OfficeChat", "OfficeChat/", "a,b", "a\\b", "a\nOptions=exec"):
            with self.subTest(directory=directory), self.assertRaises(ValueError):
                settings.validated({**request(), "destination": {**base, "directory": directory}})
        settings.validated({**request(), "destination": base})  # Old clients still select the share root.

    def test_schedule_requires_verified_offsite_backup(self):
        candidate = request("nfs", enabled=True)
        candidate["destination"] = {"kind": "nfs", "host": "nas", "export": "/safe", "version": "4.1",
                                    "require_offsite": True}
        with patch.object(settings.shutil, "which", return_value="/usr/sbin/mount.nfs"), \
                self.assertRaisesRegex(ValueError, "manual offsite"):
            settings.apply(candidate)
        self.assertFalse(settings.MOUNT_UNIT.exists())
        self.assertEqual(settings.CONFIG.read_text().splitlines()[1], "OFFSITE_ROOT=")

    def test_timer_failure_restores_config_and_timer(self):
        previous = b"[Timer]\nOnCalendar=*-*-* 04:00:00\n"
        settings.TIMER_OVERRIDE.write_bytes(previous)
        settings.TIMER_OVERRIDE.chmod(0o644)
        candidate = request()

        def fail_timer(*args, **kwargs):
            if args[:3] == (settings.SYSTEMCTL, "disable", "--now"):
                raise RuntimeError("timer failed")

        with patch.object(settings, "run", side_effect=fail_timer), self.assertRaises(RuntimeError):
            settings.apply(candidate)
        self.assertEqual(settings.TIMER_OVERRIDE.read_bytes(), previous)
        self.assertIn(b"OFFSITE_ROOT=\n", settings.CONFIG.read_bytes())

    def test_failed_executor_removes_smb_password_from_history(self):
        candidate = request("smb")
        candidate["destination"] = {"kind": "smb", "host": "fileserver", "share": "chat", "domain": "AD",
                                    "username": "backup", "password": "secret123", "require_offsite": True}
        path = settings.REQUEST_DIR / f"{candidate['request_id']}.json"
        settings.atomic_write(path, json.dumps(candidate).encode())
        with patch.object(settings, "apply", side_effect=RuntimeError("mount failed")), \
                patch.object(settings, "Path", wraps=Path) as ignored:
            # The real lock path is used in the executor; keep this test independent of system /run.
            ignored.side_effect = lambda value: (Path(self.temp.name) / "backup.lock"
                                                  if value == "/run/lock/officechat/backup.lock" else
                                                  Path(self.temp.name) / "release.lock"
                                                  if value == "/tmp/officechat-release.lock" else Path(value))
            self.assertEqual(settings.main(candidate["request_id"]), 1)
        history = path.read_text()
        self.assertNotIn("secret123", history)
        self.assertEqual(json.loads(history)["state"], "failed")

    def test_fresh_install_returns_a_valid_disabled_daily_schedule(self):
        config = replace(agent.AgentConfig(), state_directory=Path(self.temp.name) / "agent")
        config.state_directory.mkdir(mode=0o700)
        with patch.object(agent, "read_timer_status", return_value=({"enabled": False, "next_run_at": None}, None)), \
                patch.object(agent, "_parse_simple_config", return_value={"OFFSITE_ROOT": ""}):
            current = agent.SettingsController(config, jobs=None, restores=None).current()
        self.assertEqual(current["destination"], {"kind": "local"})
        self.assertEqual(len(current["schedule"]["days"]), 7)
        self.assertFalse(current["schedule"]["enabled"])

    def test_agent_queues_typed_request_without_exposing_password(self):
        config = replace(agent.AgentConfig(), state_directory=Path(self.temp.name) / "agent")
        config.state_directory.mkdir(mode=0o700)
        jobs = SimpleNamespace(active_job=lambda: None)
        restores = SimpleNamespace(_has_active_restore=lambda: False)
        controller = agent.SettingsController(config, jobs, restores)
        candidate = request("smb")
        candidate["destination"] = {"kind": "smb", "host": "fileserver", "share": "chat", "domain": "AD",
                                    "username": "backup", "password": "example-secret", "require_offsite": True}
        with patch.object(agent.subprocess, "run", return_value=SimpleNamespace(returncode=0)):
            public = controller.start({"destination": candidate["destination"], "schedule": candidate["schedule"],
                                       "requested_by_user_id": "11111111-1111-4111-8111-111111111111",
                                       "requested_by_login": "backup_admin"})
        self.assertEqual(public["state"], "queued")
        self.assertNotIn("example-secret", json.dumps(public))
        queued = controller.directory / f"{public['request_id']}.json"
        self.assertEqual(queued.stat().st_mode & 0o777, 0o600)
        self.assertEqual(json.loads(queued.read_text())["destination"]["password"], "example-secret")


if __name__ == "__main__":
    unittest.main()
