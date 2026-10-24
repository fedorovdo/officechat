"use client";

import { useEffect, useRef, useState } from "react";
import { getBackupMaintenance, getLatestBackupMaintenance, startBackupMaintenance, requireStoredAccessToken, getLocalizedApiError, type BackupMaintenance, type OfficeChatBackupStatus } from "../lib/api";
import type { Dictionary, Locale } from "../lib/i18n";
import { AdminCard } from "./AdminUI";

type Props = { dictionary: Dictionary; locale: Locale; selected: string[]; busy: boolean; status: OfficeChatBackupStatus | null; onActivityChange: (active: boolean) => void; onSaved: () => Promise<void> };
export function AdminBackupMaintenance({ dictionary, locale, selected, busy, status, onActivityChange, onSaved }: Props) {
  const text = dictionary.backups.maintenance;
  const [job, setJob] = useState<BackupMaintenance | null>(null);
  const [location, setLocation] = useState<"local" | "offsite" | "both">("both");
  const [includeProtected, setIncludeProtected] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const [confirmProtected, setConfirmProtected] = useState(false);
  const [mode, setMode] = useState<"gfs" | "days" | "disabled">("gfs");
  const [days, setDays] = useState(30);
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [dismissedPreview, setDismissedPreview] = useState(false);
  const callbacks = useRef({ onSaved, onActivityChange });
  callbacks.current = { onSaved, onActivityChange };
  const active = submitting || job?.state === "queued" || job?.state === "running";
  useEffect(() => { callbacks.current.onActivityChange(active); return () => callbacks.current.onActivityChange(false); }, [active]);
  useEffect(() => { setMode(status?.retention.mode ?? "gfs"); setDays(status?.retention.days ?? 30); }, [status?.retention.mode, status?.retention.days]);
  useEffect(() => { setDismissedPreview(true); setConfirmed(false); setConfirmProtected(false); }, [selected, location, includeProtected]);
  useEffect(() => {
    let mounted = true;
    const token = requireStoredAccessToken(locale);
    if (token) void getLatestBackupMaintenance(token).then(data => { if (mounted) setJob(data.request); }).catch(() => {});
    return () => { mounted = false; };
  }, [locale]);
  useEffect(() => {
    if (!job || !["queued", "running"].includes(job.state)) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      const token = requireStoredAccessToken(locale);
      if (!token) return;
      try {
        const current = await getBackupMaintenance(token, job!.request_id);
        if (stopped) return;
        setError("");
        setJob(current);
        if (current.state === "succeeded" && !current.operation.startsWith("preview_")) await callbacks.current.onSaved();
        if (["queued", "running"].includes(current.state)) timer = setTimeout(poll, 2000);
      } catch (err) {
        if (!stopped) { setError(getLocalizedApiError(err, dictionary.session)); timer = setTimeout(poll, 4000); }
      }
    }
    timer = setTimeout(poll, 500);
    return () => { stopped = true; clearTimeout(timer); };
  }, [job?.request_id, job?.state, locale]);
  async function start(action: "deletions/preview" | "deletions" | "retention" | "retention/preview", payload: object) {
    if (active || busy) return;
    const token = requireStoredAccessToken(locale);
    if (!token) return;
    setSubmitting(true); setError(""); setConfirmed(false); setConfirmProtected(false);
    try { setJob(await startBackupMaintenance(token, action, payload)); setDismissedPreview(false); }
    catch (err) { setError(getLocalizedApiError(err, dictionary.session)); }
    finally { setSubmitting(false); }
  }
  const preview = !dismissedPreview && job?.operation === "preview_delete" && job.state === "succeeded" ? job : null;
  const deletable = preview?.targets.filter(item => !item.reason) ?? [];
  const needsProtected = deletable.some(item => item.protected);
  const reason = (code: string | null) => code === "LAST_VERIFIED_COPY" ? text.last : code === "PROTECTED" ? text.protectedReason : code ? text.missing : text.willDelete;
  return <AdminCard title={text.title} description={text.description}>
    <fieldset disabled={busy || active}>
      <legend>{text.mode}</legend>
      <label>{text.mode}<select value={mode} onChange={event => setMode(event.target.value as typeof mode)}><option value="gfs">{text.gfs}</option><option value="days">{text.days}</option><option value="disabled">{text.disabled}</option></select></label>
      {mode === "days" ? <label>{text.daysLabel}<input type="number" min={1} max={3650} value={Number.isNaN(days) ? "" : days} onChange={event => setDays(event.target.valueAsNumber)} /></label> : null}
      <p className="note">{text.retentionNote}</p>
      {mode === "days" ? <button type="button" className="admin-button admin-button-secondary" disabled={!Number.isInteger(days) || days < 1 || days > 3650} onClick={() => void start("retention/preview", { mode, days })}>{text.previewRetention}</button> : null}
      <button type="button" className="admin-button admin-button-secondary" disabled={!Number.isInteger(days) || days < 1 || days > 3650} onClick={() => void start("retention", { mode, days })}>{text.save}</button>
    </fieldset>
    <fieldset disabled={busy || active}>
      <legend>{text.selected}: {selected.length}</legend>
      <label>{text.location}<select value={location} onChange={event => setLocation(event.target.value as typeof location)}><option value="both">{text.both}</option><option value="local">{text.local}</option><option value="offsite">{text.offsite}</option></select></label>
      <label><input type="checkbox" checked={includeProtected} onChange={event => setIncludeProtected(event.target.checked)} />{text.protected}</label>
      <p className="note">{text.limit}</p>
      <button type="button" className="admin-button admin-button-secondary" disabled={!selected.length || selected.length > 50} onClick={() => void start("deletions/preview", { backup_ids: selected, location, include_protected: includeProtected })}>{text.preview}</button>
    </fieldset>
    {active ? <p role="status">{text.working}</p> : null}
    {error ? <p role="alert" className="form-error">{error}</p> : null}
    {job?.state === "failed" ? <p role="alert" className="form-error">{job.error_code === "PREVIEW_EXPIRED" ? text.previewExpired : (text.errors[job.error_code as keyof typeof text.errors] ?? text.errors.MAINTENANCE_FAILED)}</p> : null}
    {job?.state === "succeeded" && !job.operation.startsWith("preview_") ? <p role="status" className="form-success">{text.done}</p> : null}
    {job?.operation === "preview_retention" && job.state === "succeeded" ? <section><h3>{text.previewRetention}</h3>{job.targets.length ? <ul>{job.targets.map(item => <li key={`${item.location}:${item.backup_id}`}>{item.backup_id} — {text[item.location]}: {reason(item.reason)}</li>)}</ul> : <p>{text.noCandidates}</p>}</section> : null}
    {job?.results?.length ? <ul>{job.results.map(item => <li key={`${item.location}:${item.backup_id}`}>{item.backup_id} — {text[item.location]}: {item.result === "deleted" ? text.deleted : item.result === "failed" ? text.deleteFailed : text.skipped}</li>)}</ul> : null}
    {preview ? <div role="dialog" aria-modal="true" aria-labelledby="backup-delete-title" className="settings-backdrop"><section className="settings-panel backup-confirm-panel"><h2 id="backup-delete-title">{text.confirmTitle}</h2><ul>{preview.targets.map(item => <li key={`${item.location}:${item.backup_id}`}><code>{item.backup_id}</code> — {text[item.location]}: {item.incomplete ? text.incomplete + ": " : ""}{reason(item.reason)}</li>)}</ul><label><input type="checkbox" checked={confirmed} onChange={event => setConfirmed(event.target.checked)} />{text.confirmText}</label>{needsProtected ? <label className="form-error"><input type="checkbox" checked={confirmProtected} onChange={event => setConfirmProtected(event.target.checked)} />{text.confirmProtected}</label> : null}<div className="form-actions"><button type="button" className="admin-button admin-button-secondary" onClick={() => setDismissedPreview(true)}>{text.cancel}</button><button type="button" className="admin-button" disabled={busy || active || !confirmed || !deletable.length || (needsProtected && !confirmProtected)} onClick={() => void start("deletions", { preview_id: preview.request_id, confirm_protected: confirmProtected })}>{text.confirm}</button></div></section></div> : null}
  </AdminCard>;
}
