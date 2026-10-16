from types import SimpleNamespace
from unittest.mock import AsyncMock, patch
from uuid import uuid4

from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.api.deps import get_current_user
from app.api.routes.admin_backups import router
from app.services.backup_agent import get_backup_agent_client


def setup(role='superadmin'):
    app = FastAPI()
    app.include_router(router, prefix='/backups')
    actor = SimpleNamespace(id=uuid4(), username=role, role=role, is_active=True)
    client = SimpleNamespace(request=AsyncMock(return_value={
        'request_id': str(uuid4()), 'operation': 'preview_delete', 'state': 'queued',
        'requested_at': '2026-10-16T10:00:00Z', 'targets': [], 'results': None,
    }))
    app.dependency_overrides[get_current_user] = lambda: actor
    app.dependency_overrides[get_backup_agent_client] = lambda: client
    return TestClient(app), client, actor


def test_maintenance_is_superadmin_only():
    for role in ('admin', 'user'):
        web, agent, _ = setup(role)
        with patch('app.api.deps.record_audit_event_best_effort', AsyncMock()):
            for path in ('/deletions/preview', '/deletions', '/retention', '/retention/preview'):
                response = web.post('/backups' + path, json={})
                assert response.status_code == 403
            assert web.get('/backups/maintenance/latest').status_code == 403
        agent.request.assert_not_called()


def test_preview_passes_selection_and_authenticated_actor():
    web, agent, actor = setup()
    payload = {'backup_ids': ['officechat-backup-20261015-115620Z'], 'location': 'offsite', 'include_protected': False}
    with patch('app.api.routes.admin_backups.record_audit_event_best_effort', AsyncMock()) as audit:
        assert web.post('/backups/deletions/preview', json=payload).status_code == 202
    agent.request.assert_awaited_once_with('backup_maintenance', {
        'operation': 'preview_delete', 'params': payload,
        'requested_by_user_id': str(actor.id), 'requested_by_login': actor.username,
    })
    audit.assert_awaited_once()


def test_invalid_selection_policy_and_extra_paths_rejected():
    web, agent, _ = setup()
    invalid = [
        ('/deletions/preview', {'backup_ids': ['../../etc'], 'location': 'local'}),
        ('/deletions/preview', {'backup_ids': [], 'location': 'local'}),
        ('/deletions/preview', {'backup_ids': ['officechat-backup-20261015-115620Z'] * 51, 'location': 'local'}),
        ('/retention', {'mode': 'days', 'days': 0}),
        ('/retention', {'mode': 'days', 'days': 3651}),
        ('/retention', {'mode': 'days', 'days': True}),
        ('/retention', {'mode': 'days', 'days': 30, 'root': '/etc'}),
        ('/deletions', {'preview_id': '../etc'}),
    ]
    for path, payload in invalid:
        assert web.post('/backups' + path, json=payload).status_code == 422
    agent.request.assert_not_called()
