import importlib.util
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import MagicMock, patch


MODULE_PATH = Path(__file__).resolve().parents[1] / "backup_agent.py"
SPEC = importlib.util.spec_from_file_location("officechat_restore_agent", MODULE_PATH)
agent = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = agent
SPEC.loader.exec_module(agent)
BACKUP = "officechat-backup-20261001-120000Z"
ACTOR = "11111111-1111-4111-8111-111111111111"


class RestoreControllerTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        state = Path(self.temp.name)
        state.chmod(0o700)
        self.inspector = MagicMock()
        self.inspector.backup_item.return_value = {"verification_status": "passed", "officechat_version": "0.1.0"}
        self.jobs = MagicMock()
        self.jobs.active_job.return_value = None
        self.controller = agent.RestoreController(agent.AgentConfig(state_directory=state), self.inspector, self.jobs)
        self.controller.installed_version_path = state / "VERSION"
        self.controller.installed_version_path.write_text("0.1.0\n")

    def test_confirmation_requires_fresh_challenge_reason_and_exact_host(self):
        prepared = self.controller.prepare(BACKUP, ACTOR)
        params = {
            "backup_id": BACKUP, "requested_by_user_id": ACTOR, "requested_by_login": "admin",
            "challenge": prepared["challenge"], "confirm_hostname": prepared["hostname"],
            "confirm_backup": BACKUP, "reason": "Recover after accidental removal of messages",
        }
        with self.assertRaises(agent.AgentError):
            self.controller.start({**params, "confirm_hostname": "different-host"})
        self.assertFalse(list(self.controller.directory.glob("*.json")))
        prepared = self.controller.prepare(BACKUP, ACTOR)
        with self.assertRaises(agent.AgentError):
            self.controller.start({**params, "challenge": prepared["challenge"], "reason": "too short"})
        prepared = self.controller.prepare(BACKUP, ACTOR)
        with patch.object(agent.subprocess, "run", return_value=MagicMock(returncode=0)) as run:
            request = self.controller.start({**params, "challenge": prepared["challenge"]})
        self.assertEqual(request["state"], "queued")
        self.assertEqual(self.controller.status(request["request_id"])["backup_id"], BACKUP)
        stored = json.loads((self.controller.directory / f"{request['request_id']}.json").read_text())
        self.assertEqual(stored["reason"], params["reason"])
        self.assertEqual(os.stat(self.controller.directory / f"{request['request_id']}.json").st_mode & 0o777, 0o600)
        self.assertEqual(run.call_args.args[0][1:3], ["start", "--no-block"])
        with self.assertRaises(agent.AgentError):
            self.controller.start(params)

        with patch.object(agent.subprocess, "run", return_value=MagicMock(returncode=0, stdout="ActiveState=failed\n")):
            self.assertEqual(self.controller.status(request["request_id"])["state"], "failed")

    def test_unverified_backup_and_active_operation_are_rejected(self):
        self.inspector.backup_item.return_value = {"verification_status": "failed"}
        with self.assertRaises(agent.AgentError) as error:
            self.controller.prepare(BACKUP, ACTOR)
        self.assertEqual(error.exception.code, "VERIFY_FAILED")
        self.inspector.backup_item.return_value = {"verification_status": "passed", "officechat_version": "0.1.0"}
        self.jobs.active_job.return_value = {"job_id": "busy"}
        with self.assertRaises(agent.AgentError) as error:
            self.controller.prepare(BACKUP, ACTOR)
        self.assertEqual(error.exception.code, "JOB_CONFLICT")
