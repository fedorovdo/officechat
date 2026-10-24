import importlib.util
import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import MagicMock, patch


SOURCE = Path(__file__).resolve().parents[1] / "restore_request.py"
SPEC = importlib.util.spec_from_file_location("officechat_restore_request", SOURCE)
executor = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = executor
SPEC.loader.exec_module(executor)
IDENTIFIER = "11111111-1111-4111-8111-111111111111"
BACKUP = "officechat-backup-20261001-120000Z"


class RestoreExecutorTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        root = Path(self.temp.name)
        executor.REQUEST_DIRECTORY = root / "requests"
        executor.REQUEST_DIRECTORY.mkdir(mode=0o700)
        executor.INSTALLED_VERSION = root / "VERSION"
        executor.INSTALLED_VERSION.write_text("0.1.0\n")
        self.backup_root = root / "backups"
        manifest = self.backup_root / BACKUP / "metadata"
        manifest.mkdir(parents=True)
        (manifest / "manifest.json").write_text(json.dumps({"officechat_version": "0.1.0"}))
        self.path = executor.REQUEST_DIRECTORY / f"{IDENTIFIER}.json"
        self.path.write_text(json.dumps({
            "request_id": IDENTIFIER, "backup_id": BACKUP, "backup_root": str(self.backup_root),
            "hostname": "chat-host", "reason": "Restore after an operator mistake",
            "requested_by_login": "admin", "state": "queued",
        }))
        self.path.chmod(0o600)

    def test_drill_failure_cannot_start_production_restore(self):
        with patch.object(executor.os, "geteuid", return_value=0), \
             patch.object(executor.socket, "gethostname", return_value="chat-host"), \
             patch.object(executor.subprocess, "run", return_value=MagicMock(returncode=1)) as run:
            self.assertEqual(executor.main(IDENTIFIER), 1)
        self.assertEqual(run.call_count, 1)
        self.assertIn("--verify-only", run.call_args.args[0])
        self.assertEqual(json.loads(self.path.read_text())["state"], "failed")

    def test_successful_drill_then_protected_production_script(self):
        with patch.object(executor.os, "geteuid", return_value=0), \
             patch.object(executor.socket, "gethostname", return_value="chat-host"), \
             patch.object(executor.subprocess, "run", return_value=MagicMock(returncode=0)) as run:
            self.assertEqual(executor.main(IDENTIFIER), 0)
        self.assertEqual(run.call_count, 2)
        self.assertIn("--production", run.call_args_list[1].args[0])
        self.assertEqual(json.loads(self.path.read_text())["state"], "succeeded")
