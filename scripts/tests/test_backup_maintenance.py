import importlib.util
import json
import tempfile
import unittest
from datetime import datetime, timezone, timedelta
from pathlib import Path
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('backup_maintenance', Path(__file__).resolve().parents[1] / 'backup_maintenance.py')
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)


class MaintenanceTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.base = Path(self.temp.name)
        self.local = self.base / 'local'
        self.remote = self.base / 'remote'
        self.local.mkdir()
        self.remote.mkdir()
        self.values = {'BACKUP_ROOT': str(self.local), 'OFFSITE_ROOT': str(self.remote)}
        self.config = self.base / 'backup.conf'
        self.config.write_text('APP_SECRET=unchanged\nKEEP_DAILY=14\n')
        self.config.chmod(0o600)
        self.mounts = patch.object(m, 'mounted_paths', return_value={str(self.remote): 'nfs4'})
        self.mounts.start()
        self.addCleanup(self.mounts.stop)
        self.config_patch = patch.object(m, 'CONFIG', self.config)
        self.config_patch.start()
        self.addCleanup(self.config_patch.stop)

    def backup(self, date, root=None, protected=False, verified=True):
        path = (root or self.local) / ('officechat-backup-' + date)
        path.mkdir()
        (path / 'metadata').mkdir()
        (path / 'metadata/manifest.json').write_text(json.dumps({'verification_status': 'passed' if verified else 'failed'}))
        (path / 'SUCCESS').touch()
        if protected:
            (path / 'PROTECTED').touch()
        (path / 'payload').write_text('backup content')
        return path

    def selection(self, paths, **kwargs):
        return {'backup_ids': [p.name for p in paths], 'location': 'local', 'include_protected': False, **kwargs}

    def plan(self, selection, actor='actor'):
        key = '11111111-1111-4111-8111-111111111111'
        data = {'request_id': key, 'operation': 'preview_delete', 'state': 'succeeded', 'finished_at': m.now().isoformat(),
                'requested_by_user_id': actor, 'params': selection, 'targets': m.preview(self.values, selection),
                'config_hash': m.hashlib.sha256(self.config.read_bytes()).hexdigest()}
        m.atomic_json(self.base / (key + '.json'), data)
        return {'request_id': '22222222-2222-4222-8222-222222222222', 'requested_by_user_id': actor,
                'params': {'preview_id': key, 'confirm_protected': False}}

    def test_last_verified_and_protected_per_destination(self):
        old = self.backup('20260101-000000Z', protected=True)
        latest = self.backup('20260201-000000Z')
        self.backup('20260301-000000Z', verified=False)
        self.backup('20260101-000000Z', root=self.remote)
        plan = m.preview(self.values, self.selection([old, latest], location='both'))
        self.assertEqual([v['reason'] for v in plan], ['PROTECTED', 'LAST_VERIFIED_COPY', 'LAST_VERIFIED_COPY', 'MISSING_OR_INCOMPLETE'])

    def test_delete_retains_last_and_only_selected_destination(self):
        old = self.backup('20260101-000000Z')
        last = self.backup('20260201-000000Z')
        remote = self.backup('20260101-000000Z', root=self.remote)
        data = self.plan(self.selection([old, last]))
        m.execute_delete(self.values, data, self.base)
        self.assertFalse(old.exists())
        self.assertTrue(last.exists())
        self.assertTrue(remote.exists())
        self.assertEqual([v['result'] for v in data['results']], ['deleted', 'skipped'])

    def test_protected_requires_preview_and_second_confirmation(self):
        old = self.backup('20260101-000000Z', protected=True)
        self.backup('20260201-000000Z')
        data = self.plan(self.selection([old], include_protected=True))
        with self.assertRaisesRegex(m.MaintenanceError, 'PROTECTED'):
            m.execute_delete(self.values, data, self.base)
        self.assertTrue(old.exists())
        data['params']['confirm_protected'] = True
        m.execute_delete(self.values, data, self.base)
        self.assertFalse(old.exists())

    def test_stale_config_inventory_and_actor_prevent_deletion(self):
        old = self.backup('20260101-000000Z')
        self.backup('20260201-000000Z')
        for change in ('actor', 'config', 'marker', 'expired'):
            with self.subTest(change=change):
                data = self.plan(self.selection([old]))
                if change == 'actor':
                    data['requested_by_user_id'] = 'someone-else'
                elif change == 'config':
                    self.config.write_text(self.config.read_text() + '# changed\n')
                elif change == 'marker':
                    (old / 'PROTECTED').touch()
                else:
                    path = self.base / (data['params']['preview_id'] + '.json')
                    payload = m.read_json(path)
                    payload['finished_at'] = (m.now() - timedelta(minutes=11)).isoformat()
                    m.atomic_json(path, payload)
                with self.assertRaisesRegex(m.MaintenanceError, 'PREVIEW_EXPIRED'):
                    m.execute_delete(self.values, data, self.base)
                self.assertTrue(old.exists())
                (old / 'PROTECTED').unlink(missing_ok=True)

    def test_unmounted_nas_and_traversal_rejected(self):
        with patch.object(m, 'mounted_paths', return_value={}):
            with self.assertRaisesRegex(m.MaintenanceError, 'OFFSITE_NOT_MOUNTED'):
                m.preview(self.values, {'backup_ids': ['officechat-backup-20260101-000000Z'], 'location': 'both', 'include_protected': False})
        for key in ('../../etc', 'officechat-backup-20260101-000000Z/../other'):
            with self.assertRaises(m.MaintenanceError):
                m.preview(self.values, {'backup_ids': [key], 'location': 'local', 'include_protected': False})

    def test_age_cutoff_last_verified_and_protected(self):
        old = self.backup('20260101-000000Z')
        protected = self.backup('20260102-000000Z', protected=True)
        last_verified = self.backup('20260103-000000Z')
        newer_bad = self.backup('20260120-000000Z', verified=False)
        boundary = self.backup('20260130-000000Z', verified=False)
        current = datetime(2026, 3, 1, tzinfo=timezone.utc)
        m.rotate(self.local, 30, dry_run=True, current=current)
        self.assertTrue(old.exists())
        m.rotate(self.local, 30, current=current)
        self.assertFalse(old.exists())
        self.assertFalse(newer_bad.exists())
        self.assertTrue(protected.exists())
        self.assertTrue(last_verified.exists())
        self.assertTrue(boundary.exists())

    def test_symlink_and_nested_mount_are_never_traversed(self):
        old = self.backup('20260101-000000Z')
        self.backup('20260201-000000Z')
        outside = self.base / 'outside'
        outside.mkdir()
        secret = outside / 'keep'
        secret.write_text('untouched')
        (old / 'link').symlink_to(outside, target_is_directory=True)
        data = self.plan(self.selection([old]))
        with patch.object(m, 'mounted_paths', return_value={str(old / 'mount'): 'ext4'}):
            with self.assertRaisesRegex(m.MaintenanceError, 'DELETE_FAILED'):
                m.execute_delete(self.values, data, self.base)
        self.assertEqual(data['results'][0]['result'], 'failed')
        self.assertTrue(old.exists())
        data = self.plan(self.selection([old]))
        m.execute_delete(self.values, data, self.base)
        self.assertEqual(secret.read_text(), 'untouched')

    def test_partial_failure_is_persisted(self):
        a = self.backup('20260101-000000Z')
        b = self.backup('20260102-000000Z')
        self.backup('20260201-000000Z')
        data = self.plan(self.selection([a, b]))
        original = m.remove_backup
        def fail_one(root, key, expected):
            if key == a.name:
                raise OSError('read only storage')
            original(root, key, expected)
        with patch.object(m, 'remove_backup', side_effect=fail_one):
            with self.assertRaisesRegex(m.MaintenanceError, 'DELETE_FAILED'):
                m.execute_delete(self.values, data, self.base)
        self.assertTrue(a.exists())
        self.assertFalse(b.exists())
        self.assertEqual([v['result'] for v in m.read_json(self.base / (data['request_id'] + '.json'))['results']], ['failed', 'deleted'])

    def test_config_upgrade_is_atomic_and_preserves_existing_values(self):
        m.save_policy(self.values, {'mode': 'days', 'days': 30})
        self.assertEqual(m.policy(m.config_values(self.config)), {'mode': 'days', 'days': 30})
        self.assertIn('APP_SECRET=unchanged\nKEEP_DAILY=14\n', self.config.read_text())
        self.assertEqual(self.config.stat().st_mode & 0o777, 0o600)
        for days in (0, 3651, True, '30'):
            with self.assertRaises(m.MaintenanceError):
                m.validate_policy({'mode': 'days', 'days': days})

    def test_recovery_preserves_partial_results_and_releases_only_own_lock(self):
        key = '11111111-1111-4111-8111-111111111111'
        lock = self.base / 'release.lock'
        lock.mkdir()
        (lock / 'maintenance-owner').write_text(key)
        result = [{'backup_id': 'officechat-backup-20260101-000000Z', 'result': 'deleted'}]
        m.atomic_json(self.base / (key + '.json'), {'state': 'running', 'boot_id': 'previous', 'results': result})
        with patch.object(m, 'STATE', self.base), patch.object(m, 'RELEASE_LOCK', lock):
            m.recover(key, only_previous_boot=True)
        self.assertFalse(lock.exists())
        payload = m.read_json(self.base / (key + '.json'))
        self.assertEqual(payload['error_code'], 'MAINTENANCE_INTERRUPTED')
        self.assertEqual(payload['results'], result)

    def test_remote_only_copy_and_symlink_metadata(self):
        old = self.backup('20260101-000000Z', root=self.remote)
        self.backup('20260201-000000Z', root=self.remote)
        self.assertIsNone(m.preview(self.values, self.selection([old], location='offsite'))[0]['reason'])
        unsafe = self.backup('20260101-000000Z')
        import shutil
        shutil.rmtree(unsafe / 'metadata')
        (unsafe / 'metadata').symlink_to(old / 'metadata', target_is_directory=True)
        self.assertFalse(m.inventory(self.local)[unsafe.name]['complete'])
        self.assertIsNone(m.retained_last(m.inventory(self.local)))


    def test_agent_queues_fixed_executor_and_blocks_competing_operations(self):
        from scripts.tests.test_backup_settings import agent
        from types import SimpleNamespace
        from unittest.mock import Mock
        config = SimpleNamespace(state_directory=self.base)
        jobs = SimpleNamespace(active_job=Mock(return_value=None))
        restores = SimpleNamespace(_has_active_restore=Mock(return_value=False))
        settings = SimpleNamespace(maintenance_busy=Mock(return_value=False))
        inspector = SimpleNamespace(config=config)
        protocol = agent.AgentProtocol(inspector, jobs, restores, settings)
        payload = {'operation': 'preview_delete', 'params': self.selection([self.backup('20260101-000000Z')]),
                   'requested_by_user_id': 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'requested_by_login': 'admin'}
        with patch.object(agent.subprocess, 'run', return_value=SimpleNamespace(returncode=0, stdout='ActiveState=activating')) as run:
            result = protocol.maintenance.start(payload)
            self.assertEqual(result['state'], 'queued')
            self.assertEqual(run.call_args.args[0], ['/usr/bin/systemctl', 'start', '--no-block', 'officechat-backup-maintenance@' + result['request_id'] + '.service'])
            request = {'protocol_version': 1, 'request_id': 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
                       'operation': 'create_backup', 'params': {}}
            with self.assertRaises(agent.AgentError) as raised:
                protocol.handle(request)
            self.assertEqual(raised.exception.code, 'JOB_CONFLICT')


    def test_shell_age_and_disabled_modes(self):
        import subprocess
        old = self.backup('20200101-000000Z')
        self.backup('20200102-000000Z')
        library = Path(__file__).resolve().parents[1] / 'backup/lib.sh'
        command = '. "$1"; RETENTION_MODE="$2"; RETENTION_DAYS=30; run_rotation "$3"'
        subprocess.run(['bash', '-c', command, 'test', str(library), 'disabled', str(self.local)], check=True, capture_output=True)
        self.assertTrue(old.exists())
        subprocess.run(['bash', '-c', command, 'test', str(library), 'days', str(self.local)], check=True, capture_output=True)
        self.assertFalse(old.exists())



if __name__ == '__main__':
    unittest.main()
