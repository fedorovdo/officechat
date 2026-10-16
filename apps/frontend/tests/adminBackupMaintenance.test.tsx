import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AdminBackupMaintenance } from '../components/AdminBackupMaintenance';
import ru from '../dictionaries/ru.json';

const api = vi.hoisted(() => ({ startBackupMaintenance: vi.fn(), getBackupMaintenance: vi.fn(), getLatestBackupMaintenance: vi.fn(), requireStoredAccessToken: vi.fn(() => 'token'), getLocalizedApiError: vi.fn(() => 'Error') }));
vi.mock('../lib/api', () => api);
const selected = ['officechat-backup-20260101-000000Z'];
const text = ru.backups.maintenance;
const job = { request_id: '11111111-1111-4111-8111-111111111111', operation: 'preview_delete', state: 'queued', requested_at: '2026-10-16T10:00:00Z', targets: [], results: null, error_code: null };
const target = { backup_id: selected[0], location: 'offsite', reason: null, protected: true };
const props = () => ({ dictionary: ru, locale: 'ru' as const, selected, busy: false, status: null, onActivityChange: vi.fn(), onSaved: vi.fn(async () => {}) });

beforeEach(() => { vi.clearAllMocks(); api.getLatestBackupMaintenance.mockResolvedValue({ request: null }); api.startBackupMaintenance.mockResolvedValue(job); });
describe('backup maintenance', () => {
  it('requires preview, explicit deletion confirmation and extra protected confirmation', async () => {
    api.getBackupMaintenance.mockResolvedValue({ ...job, state: 'succeeded', targets: [target] });
    render(<AdminBackupMaintenance {...props()} />);
    fireEvent.click(screen.getByLabelText(text.protected));
    fireEvent.click(screen.getByRole('button', { name: text.preview }));
    await waitFor(() => expect(screen.getByRole('dialog')).toBeInTheDocument());
    const confirm = screen.getByRole('button', { name: text.confirm });
    expect(confirm).toBeDisabled();
    fireEvent.click(screen.getByLabelText(text.confirmText));
    expect(confirm).toBeDisabled();
    fireEvent.click(screen.getByLabelText(text.confirmProtected));
    expect(confirm).toBeEnabled();
    expect(api.startBackupMaintenance).toHaveBeenCalledTimes(1);
    api.startBackupMaintenance.mockResolvedValue({ ...job, operation: 'delete' });
    fireEvent.click(confirm);
    await waitFor(() => expect(api.startBackupMaintenance).toHaveBeenLastCalledWith('token', 'deletions', { preview_id: job.request_id, confirm_protected: true }));
  });
  it('never offers deletion for the last verified copy', async () => {
    api.getBackupMaintenance.mockResolvedValue({ ...job, state: 'succeeded', targets: [{ ...target, reason: 'LAST_VERIFIED_COPY' }] });
    render(<AdminBackupMaintenance {...props()} />);
    fireEvent.click(screen.getByRole('button', { name: text.preview }));
    await waitFor(() => expect(screen.getByText(new RegExp(text.last))).toBeInTheDocument());
    fireEvent.click(screen.getByLabelText(text.confirmText));
    expect(screen.getByRole('button', { name: text.confirm })).toBeDisabled();
  });
  it('saves a 30 day policy without requesting any deletion', async () => {
    render(<AdminBackupMaintenance {...props()} />);
    fireEvent.change(screen.getByLabelText(text.mode), { target: { value: 'days' } });
    expect(screen.getByLabelText(text.daysLabel)).toHaveValue(30);
    fireEvent.click(screen.getByRole('button', { name: text.save }));
    await waitFor(() => expect(api.startBackupMaintenance).toHaveBeenCalledWith('token', 'retention', { mode: 'days', days: 30 }));
  });
  it('disables changes while another backup operation is active', () => {
    render(<AdminBackupMaintenance {...props()} busy />);
    expect(screen.getByRole('button', { name: text.preview })).toBeDisabled();
    expect(screen.getByRole('button', { name: text.save })).toBeDisabled();
  });
});
