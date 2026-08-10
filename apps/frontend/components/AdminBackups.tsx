"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";

import {
  createBackupJob,
  getActiveBackupJob,
  getBackup,
  getBackupJob,
  getBackups,
  getBackupStatus,
  getCurrentUser,
  getLocalizedApiError,
  requireStoredAccessToken,
  verifyBackup,
  type OfficeChatBackup,
  type OfficeChatBackupJob,
  type OfficeChatBackupStatus
} from "../lib/api";
import { officeChatBrand } from "../lib/brand";
import { formatFileSize } from "../lib/files";
import type { Dictionary, Locale } from "../lib/i18n";
import { AdminCard, AdminPageHeader, AdminPageShell, AdminStatCard, AdminTableContainer } from "./AdminUI";

type AdminBackupsProps = { dictionary: Dictionary; locale: Locale };

export function AdminBackups({ dictionary, locale }: AdminBackupsProps) {
  const router = useRouter();
  const [status, setStatus] = useState<OfficeChatBackupStatus | null>(null);
  const [backups, setBackups] = useState<OfficeChatBackup[]>([]);
  const [selected, setSelected] = useState<OfficeChatBackup | null>(null);
  const [verificationTarget, setVerificationTarget] = useState<string | null>(null);
  const [activeJob, setActiveJob] = useState<OfficeChatBackupJob | null>(null);
  const [confirmation, setConfirmation] = useState<"create" | "verify" | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const [hasNext, setHasNext] = useState(false);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState("");
  const statusRequestActive = useRef(false);
  const jobRequestActive = useRef(false);
  const text = dictionary.backups;
  const dateFormatter = useMemo(
    () => new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }),
    [locale]
  );

  const formatDate = useCallback((value: string | null | undefined) => (
    value ? dateFormatter.format(new Date(value)) : text.noData
  ), [dateFormatter, text.noData]);
  const formatBytes = (value: number | null | undefined) => value === null || value === undefined ? text.noData : formatFileSize(value);
  const statusLabel = (value: string) => text.values[value as keyof typeof text.values] ?? text.values.unknown;
  const warningLabel = (value: string) => text.warnings[value as keyof typeof text.warnings] ?? text.warnings.UNKNOWN;

  const loadStatus = useCallback(async (token: string) => {
    if (statusRequestActive.current) return;
    statusRequestActive.current = true;
    try {
      setStatus(await getBackupStatus(token));
    } catch (caughtError) {
      setError(getLocalizedApiError(caughtError, dictionary.session));
    } finally {
      statusRequestActive.current = false;
    }
  }, [dictionary.session]);

  const loadList = useCallback(async (token: string, selectedPage: number) => {
    try {
      const response = await getBackups(token, selectedPage, 25);
      setBackups(response.items);
      setTotal(response.total);
      setHasNext(response.has_next);
    } catch (caughtError) {
      setBackups([]);
      setTotal(0);
      setHasNext(false);
      setError(getLocalizedApiError(caughtError, dictionary.session));
    }
  }, [dictionary.session]);

  const loadAll = useCallback(async (selectedPage: number) => {
    const token = requireStoredAccessToken(locale);
    if (!token) return;
    setRefreshing(true);
    setError("");
    const active = await getActiveBackupJob(token).catch(() => ({ job: null }));
    setActiveJob((current) => current && ["queued", "running", "verifying"].includes(current.state) ? current : active.job);
    await Promise.all([loadStatus(token), loadList(token, selectedPage)]);
    setRefreshing(false);
    setLoading(false);
  }, [loadList, loadStatus, locale]);

  const refreshBackupData = useCallback(async () => {
    const token = requireStoredAccessToken(locale);
    if (!token) return;
    await Promise.all([loadStatus(token), loadList(token, page)]);
  }, [loadList, loadStatus, locale, page]);

  useEffect(() => {
    const token = requireStoredAccessToken(locale);
    if (!token) return;
    void getCurrentUser(token).then((user) => {
      if (user.role !== "superadmin") {
        router.replace(`/${locale}/dashboard`);
        return;
      }
      void loadAll(1);
    }).catch((caughtError) => {
      setError(getLocalizedApiError(caughtError, dictionary.session));
      setLoading(false);
    });
  }, [dictionary.session, loadAll, locale, router]);

  useEffect(() => {
    const token = requireStoredAccessToken(locale);
    if (!token) return;
    const interval = window.setInterval(() => void loadStatus(token), 60_000);
    return () => window.clearInterval(interval);
  }, [loadStatus, locale]);

  useEffect(() => {
    if (!activeJob || !["queued", "running", "verifying"].includes(activeJob.state)) return;
    const token = requireStoredAccessToken(locale);
    if (!token) return;
    const poll = async () => {
      if (jobRequestActive.current) return;
      jobRequestActive.current = true;
      try {
        const job = await getBackupJob(token, activeJob.job_id);
        setActiveJob(job);
        if (job.state === "succeeded") await refreshBackupData();
      } catch (caughtError) {
        setError(getLocalizedApiError(caughtError, dictionary.session));
      } finally {
        jobRequestActive.current = false;
      }
    };
    const interval = window.setInterval(() => void poll(), 3_000);
    return () => window.clearInterval(interval);
  }, [activeJob, dictionary.session, locale, refreshBackupData]);

  useEffect(() => {
    if (!activeJob || !["queued", "running", "verifying"].includes(activeJob.state)) return;
    const interval = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(interval);
  }, [activeJob]);

  async function openDetails(backupId: string) {
    const token = requireStoredAccessToken(locale);
    if (!token) return;
    try {
      setSelected(await getBackup(token, backupId));
    } catch (caughtError) {
      setError(getLocalizedApiError(caughtError, dictionary.session));
    }
  }

  async function changePage(nextPage: number) {
    setPage(nextPage);
    const token = requireStoredAccessToken(locale);
    if (token) await loadList(token, nextPage);
  }

  async function startConfirmedJob() {
    const token = requireStoredAccessToken(locale);
    if (!token || !confirmation || submitting) return;
    setSubmitting(true);
    setError("");
    try {
      const job = confirmation === "create"
        ? await createBackupJob(token)
        : await verifyBackup(token, verificationTarget ?? "");
      setActiveJob(job);
      setConfirmation(null);
      setVerificationTarget(null);
    } catch (caughtError) {
      setError(getLocalizedApiError(caughtError, dictionary.session));
    } finally {
      setSubmitting(false);
    }
  }

  const warnings = Array.from(new Set([
    ...(status?.warnings ?? []),
    ...(status?.agent_status === "unavailable" ? ["BACKUP_AGENT_UNAVAILABLE"] : [])
  ]));
  const lastVerified = status?.last_run?.verification_status ?? "unknown";
  const restoreReady = status?.last_success?.verification_status === "passed";
  const docsName = locale === "ru" ? "BACKUP_RESTORE_RU.md" : "BACKUP_RESTORE.md";
  const docsUrl = `${officeChatBrand.repositoryUrl.replace(/\/$/, "")}/blob/main/docs/${docsName}`;
  const jobBusy = Boolean(activeJob && ["queued", "running", "verifying"].includes(activeJob.state));
  const jobDuration = activeJob?.started_at
    ? Math.max(0, Math.floor(((activeJob.finished_at ? new Date(activeJob.finished_at).getTime() : now) - new Date(activeJob.started_at).getTime()) / 1000))
    : 0;
  const restoreBackupId = selected?.backup_id ?? status?.last_success?.backup_id ?? "<BACKUP_ID>";
  const restoreCommand = `/opt/officechat/restore-production.sh \\\n  --config /etc/officechat/backup.conf \\\n  --backup-id ${restoreBackupId} \\\n  --verify-only`;

  return (
    <AdminPageShell ariaLabel={text.title} className="admin-backups-page" wide>
      <AdminPageHeader
        actions={<><button className="admin-button" disabled={jobBusy || refreshing} onClick={() => setConfirmation("create")} type="button">{text.createBackup}</button><button className="admin-button admin-button-secondary" disabled={refreshing} onClick={() => void loadAll(page)} type="button">{refreshing ? text.refreshing : text.refresh}</button></>}
        backHref={`/${locale}/dashboard`}
        backLabel={dictionary.adminUi.backToDashboard}
        description={text.description}
        title={text.title}
      />
      {error ? <p className="form-error">{error}</p> : null}
      {warnings.length > 0 ? <section aria-label={text.systemWarnings} className="backup-warning-banner"><strong>{text.systemWarnings}</strong><ul>{warnings.map((warning) => <li key={warning}>{warningLabel(warning)}</li>)}</ul></section> : null}
      {activeJob ? <AdminCard className={`backup-job-panel backup-job-${activeJob.state}`} title={text.activeJobTitle} description={text.jobMessages[activeJob.state as keyof typeof text.jobMessages] ?? text.jobMessages.unknown}>
        <dl className="backup-job-grid"><div><dt>{text.jobOperation}</dt><dd>{statusLabel(activeJob.operation)}</dd></div><div><dt>{text.jobState}</dt><dd>{statusLabel(activeJob.state)}</dd></div><div><dt>{text.id}</dt><dd>{activeJob.backup_id ?? text.noData}</dd></div><div><dt>{text.jobStarted}</dt><dd>{formatDate(activeJob.started_at ?? activeJob.requested_at)}</dd></div><div><dt>{text.jobDuration}</dt><dd>{jobDuration} {text.seconds}</dd></div><div><dt>{text.jobResult}</dt><dd>{activeJob.success === null ? text.noData : (activeJob.success ? text.values.success : text.values.failure)}</dd></div></dl>
        {activeJob.last_error ? <p className="form-error">{text.jobErrors[activeJob.last_error as keyof typeof text.jobErrors] ?? text.jobErrors.UNKNOWN}</p> : null}
      </AdminCard> : null}

      <section aria-label={text.statusTitle} className="backup-status-grid">
        <AdminStatCard label={text.lastSuccess} value={formatDate(status?.last_success?.timestamp)} />
        <AdminStatCard label={text.lastRun} value={formatDate(status?.last_run?.timestamp)} />
        <AdminStatCard label={text.verification} value={statusLabel(lastVerified)} />
        <AdminStatCard label={text.lastSize} value={formatBytes(status?.last_success?.backup_size_bytes)} />
        <AdminStatCard label={text.freeSpace} value={formatBytes(status?.backup_root_capacity.free_bytes)} />
        <AdminStatCard label={text.nextRun} value={status?.timer.enabled ? formatDate(status.timer.next_run_at) : text.timerDisabled} />
        <AdminStatCard label={text.offsite} value={statusLabel(status?.offsite.status ?? "unknown")} />
      </section>

      <AdminCard className="backup-list-card" description={text.listDescription} title={text.listTitle}>
        <AdminTableContainer className="backup-table-wrap">
          <table className="admin-table backup-table">
            <thead><tr><th>{text.date}</th><th>{text.id}</th><th>{text.type}</th><th>{text.size}</th><th>{text.version}</th><th>{text.migration}</th><th>{text.verification}</th><th>{text.offsite}</th><th>{text.actions}</th></tr></thead>
            <tbody>{backups.map((backup) => <tr key={backup.backup_id}>
              <td>{formatDate(backup.created_at)}</td><td><code title={backup.backup_id}>{backup.backup_id}</code></td><td>{statusLabel(backup.backup_type)}</td><td>{formatBytes(backup.size_bytes)}</td><td>{backup.officechat_version ?? text.noData}</td><td>{backup.alembic_revision ?? text.noData}</td><td><span className={`admin-badge backup-badge-${backup.verification_status}`}>{statusLabel(backup.verification_status)}</span></td><td>{statusLabel(backup.offsite_status)}</td><td><button className="table-action" onClick={() => void openDetails(backup.backup_id)} type="button">{text.details}</button></td>
            </tr>)}</tbody>
          </table>
          {!loading && backups.length === 0 ? <p className="sidebar-empty-state">{status?.agent_status === "unavailable" ? text.agentUnavailable : text.empty}</p> : null}
          {loading ? <p className="muted">{text.loading}</p> : null}
        </AdminTableContainer>
        <div className="backup-pagination"><button className="secondary-link" disabled={page <= 1} onClick={() => void changePage(page - 1)} type="button">{text.previous}</button><span>{text.total}: {total}</span><button className="secondary-link" disabled={!hasNext} onClick={() => void changePage(page + 1)} type="button">{text.next}</button></div>
      </AdminCard>

      <section className="backup-secondary-grid">
        <AdminCard title={text.scheduleTitle} description={text.scheduleDescription}>
          <dl className="backup-detail-list"><dt>{text.timerInstalled}</dt><dd>{status ? (status.timer.installed ? text.yes : text.no) : text.noData}</dd><dt>{text.timerEnabled}</dt><dd>{status ? (status.timer.enabled ? text.yes : text.no) : text.noData}</dd><dt>{text.timerActive}</dt><dd>{status ? (status.timer.active ? text.yes : text.no) : text.noData}</dd><dt>{text.nextRun}</dt><dd>{formatDate(status?.timer.next_run_at)}</dd><dt>{text.daily}</dt><dd>{status?.retention.daily ?? text.noData}</dd><dt>{text.weekly}</dt><dd>{status?.retention.weekly ?? text.noData}</dd><dt>{text.monthly}</dt><dd>{status?.retention.monthly ?? text.noData}</dd></dl>
          <p className="note">{text.scheduleFuture}</p>
        </AdminCard>
        <AdminCard title={text.restoreTitle} description={text.restoreDescription}>
          <p className={restoreReady ? "form-success" : "note"}>{restoreReady ? text.restoreReady : text.restoreUnavailable}</p>
          <p>{text.restoreServerOnly}</p>
          <pre className="backup-cli-example"><code>{restoreCommand}</code></pre>
          <a className="admin-button admin-button-secondary" href={docsUrl} rel="noreferrer" target="_blank">{text.documentation}</a>
        </AdminCard>
      </section>

      {selected ? <div className="settings-backdrop" role="presentation"><section aria-labelledby="backup-details-title" aria-modal="true" className="settings-panel backup-details-panel" role="dialog"><div className="dashboard-header"><h2 id="backup-details-title">{text.detailTitle}</h2><button className="secondary-link" onClick={() => setSelected(null)} type="button">{text.close}</button></div><dl className="backup-detail-list"><dt>{text.id}</dt><dd><code>{selected.backup_id}</code></dd><dt>{text.date}</dt><dd>{formatDate(selected.created_at)}</dd><dt>{text.type}</dt><dd>{statusLabel(selected.backup_type)}</dd><dt>{text.size}</dt><dd>{formatBytes(selected.size_bytes)}</dd><dt>{text.version}</dt><dd>{selected.officechat_version ?? text.noData}</dd><dt>{text.buildSha}</dt><dd>{selected.build_sha ?? text.noData}</dd><dt>{text.migration}</dt><dd>{selected.alembic_revision ?? text.noData}</dd><dt>{text.postgresql}</dt><dd>{selected.postgresql_version ?? text.noData}</dd><dt>{text.verification}</dt><dd>{statusLabel(selected.verification_status)}</dd><dt>{text.offsite}</dt><dd>{statusLabel(selected.offsite_status)}</dd><dt>{text.components}</dt><dd>{selected.components.length ? selected.components.join(", ") : text.noData}</dd><dt>{text.protected}</dt><dd>{selected.protected ? text.yes : text.no}</dd></dl>{selected.warnings.length ? <div className="backup-detail-warnings"><strong>{text.systemWarnings}</strong><ul>{selected.warnings.map((warning) => <li key={warning}>{warningLabel(warning)}</li>)}</ul></div> : null}<button className="admin-button" disabled={jobBusy} onClick={() => { setVerificationTarget(selected.backup_id); setSelected(null); setConfirmation("verify"); }} type="button">{text.verifyBackup}</button></section></div> : null}
      {confirmation ? <div className="settings-backdrop" role="presentation"><section aria-labelledby="backup-confirm-title" aria-modal="true" className="settings-panel backup-confirm-panel" role="dialog"><h2 id="backup-confirm-title">{confirmation === "create" ? text.createConfirmTitle : text.verifyConfirmTitle}</h2><p>{confirmation === "create" ? text.createConfirmDescription : text.verifyConfirmDescription}</p>{confirmation === "create" ? <ul><li>{text.createConfirmDuration}</li><li>{text.createConfirmParallel}</li><li>{text.createConfirmAvailable}</li><li>{text.createConfirmOffsite}</li></ul> : <p className="note">{text.verifyProductionSafe}</p>}<div className="form-actions"><button className="admin-button admin-button-secondary" disabled={submitting} onClick={() => { setConfirmation(null); setVerificationTarget(null); }} type="button">{text.cancel}</button><button className="admin-button" disabled={submitting} onClick={() => void startConfirmedJob()} type="button">{submitting ? text.starting : (confirmation === "create" ? text.confirmCreate : text.confirmVerify)}</button></div></section></div> : null}
    </AdminPageShell>
  );
}
