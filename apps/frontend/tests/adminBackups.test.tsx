import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { AdminBackups } from "../components/AdminBackups";
import en from "../dictionaries/en.json";
import ru from "../dictionaries/ru.json";
import { userFactory } from "./factories";

const apiMocks = vi.hoisted(() => ({
  createBackupJob: vi.fn(),
  getActiveBackupJob: vi.fn(),
  getBackup: vi.fn(),
  getBackupJob: vi.fn(),
  getBackups: vi.fn(),
  getBackupStatus: vi.fn(),
  getCurrentUser: vi.fn(),
  requireStoredAccessToken: vi.fn(() => "test-token"),
  verifyBackup: vi.fn()
}));
const routerReplace = vi.fn();

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: routerReplace })
}));

vi.mock("../lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/api")>();
  return { ...actual, ...apiMocks };
});

const backup = {
  backup_id: "officechat-backup-20260804-120000Z",
  created_at: "2026-08-04T12:00:00Z",
  backup_type: "pre_upgrade" as const,
  size_bytes: 2048,
  verification_status: "passed" as const,
  verified_at: null,
  offsite_status: "copied" as const,
  officechat_version: "0.1.0-rc11",
  build_sha: "abcdef012345",
  alembic_revision: "20260728_0026",
  postgresql_version: "16.4",
  pre_upgrade: true,
  protected: true,
  warnings: [],
  components: ["database", "uploads"]
};

const status = {
  agent_status: "available" as const,
  backup_health: "healthy" as const,
  current_result: "success" as const,
  last_run: {
    timestamp: backup.created_at,
    success: true,
    backup_id: backup.backup_id,
    backup_size_bytes: backup.size_bytes,
    duration_seconds: 42,
    offsite_status: "copied" as const,
    verification_status: "passed" as const,
    last_error: null
  },
  last_success: {
    timestamp: backup.created_at,
    success: true,
    backup_id: backup.backup_id,
    backup_size_bytes: backup.size_bytes,
    duration_seconds: 42,
    offsite_status: "copied" as const,
    verification_status: "passed" as const,
    last_error: null
  },
  backup_root_capacity: { total_bytes: 10000, used_bytes: 2000, free_bytes: 8000, usage_percent: 20 },
  timer: {
    installed: true, enabled: true, active: true,
    next_run_at: "2026-08-05T02:30:00Z", last_trigger_at: backup.created_at,
    unit_name: "officechat-backup.timer" as const
  },
  retention: { daily: 14, weekly: 8, monthly: 12 },
  offsite: { configured: true, required: false, status: "copied" as const },
  warnings: []
};

const job = {
  job_id: "00000000-0000-4000-8000-000000000123",
  operation: "create_backup" as const,
  state: "queued" as const,
  phase: "queued",
  backup_id: null,
  requested_at: "2026-08-05T10:00:00Z",
  started_at: null,
  finished_at: null,
  success: null,
  exit_code: null,
  safe_message: "Backup operation is queued",
  last_error: null
};

describe("Backup Center", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    apiMocks.requireStoredAccessToken.mockReturnValue("test-token");
    apiMocks.getCurrentUser.mockResolvedValue(userFactory({ role: "superadmin" }));
    apiMocks.getBackupStatus.mockResolvedValue(status);
    apiMocks.getActiveBackupJob.mockResolvedValue({ job: null });
    apiMocks.getBackups.mockResolvedValue({ items: [backup], page: 1, limit: 25, total: 1, has_next: false });
    apiMocks.getBackup.mockResolvedValue(backup);
    apiMocks.createBackupJob.mockResolvedValue(job);
    apiMocks.verifyBackup.mockResolvedValue({ ...job, operation: "verify_backup", backup_id: backup.backup_id });
    apiMocks.getBackupJob.mockResolvedValue({ ...job, state: "running", started_at: job.requested_at });
  });

  it("renders the header, seven status cards, table, and read-only sections", async () => {
    const { container } = render(<AdminBackups dictionary={en} locale="en" />);
    await screen.findByText(backup.backup_id);

    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
    expect(screen.getByRole("link", { name: en.adminUi.backToDashboard })).toHaveAttribute("href", "/en/dashboard");
    expect(within(screen.getByLabelText(en.backups.statusTitle)).getAllByRole("article")).toHaveLength(7);
    expect(container.querySelector(".backup-table-wrap")).toHaveClass("admin-table-container");
    expect(screen.getByText(en.backups.scheduleFuture)).toBeInTheDocument();
    expect(screen.getByText(/--verify-only/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: en.backups.createBackup })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /restore/i })).not.toBeInTheDocument();
    expect(container.querySelector(".backup-secondary-grid")).toBeInTheDocument();
  });

  it("opens safe details without filesystem paths", async () => {
    const { container } = render(<AdminBackups dictionary={en} locale="en" />);
    fireEvent.click(await screen.findByRole("button", { name: en.backups.details }));
    const dialog = await screen.findByRole("dialog", { name: en.backups.detailTitle });
    expect(within(dialog).getByText("abcdef012345")).toBeInTheDocument();
    expect(within(dialog).getByText("database, uploads")).toBeInTheDocument();
    expect(container.textContent).not.toContain("/var/backups");
    expect(container.textContent).not.toContain("offsite/path");
  });

  it("shows agent unavailable and warnings without a toast loop", async () => {
    apiMocks.getBackupStatus.mockResolvedValue({
      ...status,
      agent_status: "unavailable",
      backup_health: "unknown",
      current_result: "unknown",
      last_run: null,
      last_success: null,
      warnings: ["BACKUP_AGENT_UNAVAILABLE", "STATUS_CORRUPT", "TIMER_DISABLED"]
    });
    apiMocks.getBackups.mockRejectedValue(new Error("Backup agent is unavailable"));
    render(<AdminBackups dictionary={ru} locale="ru" />);

    expect(await screen.findByText(ru.backups.warnings.BACKUP_AGENT_UNAVAILABLE)).toBeInTheDocument();
    expect(screen.getByText(ru.backups.warnings.STATUS_CORRUPT)).toBeInTheDocument();
    expect(screen.getByText(ru.backups.agentUnavailable)).toBeInTheDocument();
  });

  it("refreshes status and list only from the refresh button", async () => {
    render(<AdminBackups dictionary={en} locale="en" />);
    await screen.findByText(backup.backup_id);
    const before = apiMocks.getBackupStatus.mock.calls.length;
    fireEvent.click(screen.getByRole("button", { name: en.backups.refresh }));
    await waitFor(() => expect(apiMocks.getBackupStatus.mock.calls.length).toBeGreaterThan(before));
    expect(apiMocks.getBackups).toHaveBeenCalled();
  });

  it("redirects normal administrators away from the superadmin-only route", async () => {
    apiMocks.getCurrentUser.mockResolvedValue(userFactory({ role: "admin" }));
    render(<AdminBackups dictionary={en} locale="en" />);
    await waitFor(() => expect(routerReplace).toHaveBeenCalledWith("/en/dashboard"));
    expect(apiMocks.getBackupStatus).not.toHaveBeenCalled();
  });

  it("starts a backup only after confirmation and disables duplicate actions", async () => {
    render(<AdminBackups dictionary={en} locale="en" />);
    const create = await screen.findByRole("button", { name: en.backups.createBackup });
    fireEvent.click(create);
    expect(apiMocks.createBackupJob).not.toHaveBeenCalled();
    const dialog = screen.getByRole("dialog", { name: en.backups.createConfirmTitle });
    fireEvent.click(within(dialog).getByRole("button", { name: en.backups.confirmCreate }));
    await waitFor(() => expect(apiMocks.createBackupJob).toHaveBeenCalledWith("test-token"));
    expect(await screen.findByText(en.backups.activeJobTitle)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: en.backups.createBackup })).toBeDisabled();
  });

  it("uses verify-only confirmation from details and never renders restore action", async () => {
    render(<AdminBackups dictionary={ru} locale="ru" />);
    fireEvent.click(await screen.findByRole("button", { name: ru.backups.details }));
    await screen.findByRole("dialog", { name: ru.backups.detailTitle });
    fireEvent.click(screen.getByRole("button", { name: ru.backups.verifyBackup }));
    const dialog = screen.getByRole("dialog", { name: ru.backups.verifyConfirmTitle });
    expect(screen.queryByRole("dialog", { name: ru.backups.detailTitle })).not.toBeInTheDocument();
    expect(within(dialog).getByText(ru.backups.verifyProductionSafe)).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole("button", { name: ru.backups.confirmVerify }));
    await waitFor(() => expect(apiMocks.verifyBackup).toHaveBeenCalledWith("test-token", backup.backup_id));
    expect(screen.queryByRole("button", { name: /restore|восстанов/i })).not.toBeInTheDocument();
  });

  it("polls an active job and clears polling when unmounted", async () => {
    const intervals: Array<{
      callback: TimerHandler;
      delay: number | undefined;
      id: ReturnType<typeof window.setInterval>;
    }> = [];
    let nextId = 1;
    const intervalSpy = vi.spyOn(window, "setInterval").mockImplementation((callback, delay) => {
      const id = nextId++ as unknown as ReturnType<typeof window.setInterval>;
      intervals.push({ callback, delay, id });
      return id;
    });
    const clearSpy = vi.spyOn(window, "clearInterval").mockImplementation(() => undefined);
    apiMocks.getActiveBackupJob.mockResolvedValue({
      job: { ...job, state: "running", started_at: job.requested_at }
    });
    apiMocks.getBackupJob.mockResolvedValue({
      ...job,
      state: "succeeded",
      started_at: job.requested_at,
      finished_at: "2026-08-05T10:01:00Z",
      success: true,
      exit_code: 0
    });

    const { unmount } = render(<AdminBackups dictionary={en} locale="en" />);
    await screen.findByText(en.backups.activeJobTitle);
    const pollingInterval = intervals.find(({ delay }) => delay === 3_000);
    expect(pollingInterval).toBeDefined();
    const statusCallsBeforePoll = apiMocks.getBackupStatus.mock.calls.length;
    await act(async () => {
      if (typeof pollingInterval?.callback === "function") pollingInterval.callback();
      await Promise.resolve();
    });
    await waitFor(() => expect(apiMocks.getBackupJob).toHaveBeenCalledWith("test-token", job.job_id));
    await waitFor(() => expect(apiMocks.getBackupStatus.mock.calls.length).toBeGreaterThan(statusCallsBeforePoll));

    unmount();
    expect(clearSpy).toHaveBeenCalledWith(pollingInterval?.id);
    intervalSpy.mockRestore();
    clearSpy.mockRestore();
  });

  it("keeps RU and EN dictionary key sets aligned", () => {
    expect(Object.keys(en.backups).sort()).toEqual(Object.keys(ru.backups).sort());
    expect(Object.keys(en.backups.values).sort()).toEqual(Object.keys(ru.backups.values).sort());
    expect(Object.keys(en.backups.warnings).sort()).toEqual(Object.keys(ru.backups.warnings).sort());
    expect(Object.keys(en.backups.jobMessages).sort()).toEqual(Object.keys(ru.backups.jobMessages).sort());
    expect(Object.keys(en.backups.jobErrors).sort()).toEqual(Object.keys(ru.backups.jobErrors).sort());
    expect(en.backups.jobErrors.JOB_INTERRUPTED).toBeTruthy();
    expect(en.backups.jobErrors.EXECUTOR_UNAVAILABLE).toBeTruthy();
    expect(en.backups.jobErrors.EXECUTOR_TIMEOUT).toBeTruthy();
  });
});
