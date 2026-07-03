"use client";

import Link from "next/link";
import { FormEvent, useEffect, useState } from "react";
import { useRouter } from "next/navigation";

import {
  clearStoredAccessToken,
  getCurrentUser,
  getRetentionSettings,
  getStorageStats,
  getStoredAccessToken,
  isAdminRole,
  previewRetentionCleanup,
  runRetentionCleanup,
  updateRetentionSettings,
  type RetentionRunResult,
  type RetentionSettings,
  type RetentionSettingsUpdate,
  type StorageStats
} from "../lib/api";
import { formatFileSize } from "../lib/files";
import type { Dictionary, Locale } from "../lib/i18n";

type AdminStorageProps = { dictionary: Dictionary; locale: Locale };

export function AdminStorage({ dictionary, locale }: AdminStorageProps) {
  const router = useRouter();
  const [settings, setSettings] = useState<RetentionSettings | null>(null);
  const [form, setForm] = useState<RetentionSettingsUpdate | null>(null);
  const [stats, setStats] = useState<StorageStats | null>(null);
  const [preview, setPreview] = useState<RetentionRunResult | null>(null);
  const [result, setResult] = useState<RetentionRunResult | null>(null);
  const [confirmRun, setConfirmRun] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");

  async function loadData(token: string) {
    const [loadedSettings, loadedStats] = await Promise.all([
      getRetentionSettings(token),
      getStorageStats(token)
    ]);
    setSettings(loadedSettings);
    setForm({
      retention_enabled: loadedSettings.retention_enabled,
      active_history_days: loadedSettings.active_history_days,
      archive_enabled: loadedSettings.archive_enabled,
      attachment_retention_days: loadedSettings.attachment_retention_days,
      delete_archived_after_days: loadedSettings.delete_archived_after_days,
      cleanup_batch_size: loadedSettings.cleanup_batch_size,
      cleanup_interval_hours: loadedSettings.cleanup_interval_hours
    });
    setStats(loadedStats);
  }

  useEffect(() => {
    const token = getStoredAccessToken();
    if (!token) {
      router.replace(`/${locale}/login`);
      return;
    }
    void getCurrentUser(token)
      .then((user) => {
        if (!isAdminRole(user.role)) throw new Error("access-denied");
        return loadData(token);
      })
      .catch((caughtError) => {
        if (caughtError instanceof Error && caughtError.message === "access-denied") {
          router.replace(`/${locale}/dashboard`);
          return;
        }
        clearStoredAccessToken();
        router.replace(`/${locale}/login`);
      });
  }, [locale, router]);

  function updateField<Key extends keyof RetentionSettingsUpdate>(
    key: Key,
    value: RetentionSettingsUpdate[Key]
  ) {
    setForm((current) => current ? { ...current, [key]: value } : current);
    setPreview(null);
    setResult(null);
  }

  async function saveSettings(event: FormEvent) {
    event.preventDefault();
    const token = getStoredAccessToken();
    if (!token || !form || !settings) return;
    if (!settings.retention_enabled && form.retention_enabled && !window.confirm(dictionary.retention.confirmEnable)) {
      return;
    }
    setBusy(true);
    setError("");
    setSuccess("");
    try {
      const updated = await updateRetentionSettings(token, form);
      setSettings(updated);
      await loadData(token);
      setSuccess(dictionary.retention.saved);
    } catch (caughtError) {
      setError(caughtError instanceof Error ? caughtError.message : dictionary.retention.saveError);
    } finally {
      setBusy(false);
    }
  }

  async function previewCleanup() {
    const token = getStoredAccessToken();
    if (!token) return;
    setBusy(true);
    setError("");
    try {
      setPreview(await previewRetentionCleanup(token));
      setResult(null);
    } catch (caughtError) {
      setError(caughtError instanceof Error ? caughtError.message : dictionary.retention.cleanupError);
    } finally {
      setBusy(false);
    }
  }

  async function runCleanup() {
    const token = getStoredAccessToken();
    if (!token) return;
    setBusy(true);
    setError("");
    try {
      const completed = await runRetentionCleanup(token);
      setResult(completed);
      setConfirmRun(false);
      setPreview(null);
      await loadData(token);
    } catch (caughtError) {
      setError(caughtError instanceof Error ? caughtError.message : dictionary.retention.cleanupError);
    } finally {
      setBusy(false);
    }
  }

  function summaryView(report: RetentionRunResult) {
    const summary = report.summary;
    return (
      <div className="retention-summary">
        <span>{dictionary.retention.messagesToArchive}: <strong>{summary.group_messages_archived + summary.direct_messages_archived + summary.discussion_messages_archived}</strong></span>
        <span>{dictionary.retention.filesToRemove}: <strong>{summary.attachments_deleted}</strong></span>
        <span>{dictionary.retention.missingFiles}: <strong>{summary.files_missing}</strong></span>
        {summary.errors.map((message) => <p className="form-error" key={message}>{message}</p>)}
      </div>
    );
  }

  return (
    <main className="dashboard admin-storage-page">
      <section className="dashboard-shell admin-storage-shell">
        <div className="dashboard-header">
          <div>
            <p className="eyebrow">OfficeChat</p>
            <h1 className="dashboard-title">{dictionary.retention.title}</h1>
            <p className="muted">{dictionary.retention.subtitle}</p>
          </div>
          <Link className="secondary-link" href={`/${locale}/dashboard`}>{dictionary.retention.back}</Link>
        </div>
        {error ? <p className="form-error">{error}</p> : null}
        {success ? <p className="form-success">{success}</p> : null}

        {stats ? (
          <section className="retention-section">
            <h2>{dictionary.retention.overview}</h2>
            <div className="storage-stat-grid">
              {[
                [dictionary.retention.totalStorage, formatFileSize(stats.uploads_total_bytes)],
                [dictionary.retention.avatars, formatFileSize(stats.avatar_bytes)],
                [dictionary.retention.groupFiles, formatFileSize(stats.group_attachment_bytes)],
                [dictionary.retention.directFiles, formatFileSize(stats.direct_attachment_bytes)],
                [dictionary.retention.discussionFiles, formatFileSize(stats.discussion_attachment_bytes)],
                [dictionary.retention.attachmentCount, String(stats.attachment_count)],
                [dictionary.retention.missingFileCount, String(stats.missing_file_count)],
                [dictionary.retention.activeMessages, String(stats.message_counts.active)],
                [dictionary.retention.archivedMessages, String(stats.message_counts.archived)],
                [dictionary.retention.deletedMessages, String(stats.message_counts.soft_deleted)]
              ].map(([label, value]) => (
                <div className="storage-stat" key={label}><span>{label}</span><strong>{value}</strong></div>
              ))}
            </div>
          </section>
        ) : null}

        {form && settings ? (
          <form className="retention-section retention-form" onSubmit={saveSettings}>
            <h2>{dictionary.retention.policy}</h2>
            <p className={form.retention_enabled ? "form-success" : "note"}>
              {form.retention_enabled ? dictionary.retention.enabled : dictionary.retention.disabled}
            </p>
            <label className="checkbox-row"><input checked={form.retention_enabled} onChange={(event) => updateField("retention_enabled", event.target.checked)} type="checkbox" />{dictionary.retention.enable}</label>
            <label className="checkbox-row"><input checked={form.archive_enabled} onChange={(event) => updateField("archive_enabled", event.target.checked)} type="checkbox" />{dictionary.retention.archiveEnabled}</label>
            <div className="retention-fields">
              <label>{dictionary.retention.activeHistoryDays}<input className="field-input" min={0} max={36500} onChange={(event) => updateField("active_history_days", Number(event.target.value))} type="number" value={form.active_history_days} /><small>{dictionary.retention.keepIndefinitely}</small></label>
              <label>{dictionary.retention.attachmentRetention}<input className="field-input" min={0} max={36500} onChange={(event) => updateField("attachment_retention_days", event.target.value === "" ? null : Number(event.target.value))} type="number" value={form.attachment_retention_days ?? ""} /><small>{dictionary.retention.attachmentRetentionHint}</small></label>
              <label>{dictionary.retention.batchSize}<input className="field-input" min={1} max={5000} onChange={(event) => updateField("cleanup_batch_size", Number(event.target.value))} type="number" value={form.cleanup_batch_size} /></label>
              <label>{dictionary.retention.interval}<input className="field-input" min={1} max={8760} onChange={(event) => updateField("cleanup_interval_hours", Number(event.target.value))} type="number" value={form.cleanup_interval_hours} /></label>
            </div>
            <p className="note">{dictionary.retention.permanentDeletionPlanned}</p>
            <button className="primary-button" disabled={busy} type="submit">{dictionary.retention.save}</button>
          </form>
        ) : null}

        <section className="retention-section">
          <h2>{dictionary.retention.preview}</h2>
          <div className="actions">
            <button className="secondary-link" disabled={busy || !settings} onClick={() => void previewCleanup()} type="button">{dictionary.retention.preview}</button>
            <button className="danger-button" disabled={busy || !preview || !settings?.retention_enabled} onClick={() => setConfirmRun(true)} type="button">{busy ? dictionary.retention.running : dictionary.retention.run}</button>
          </div>
          {preview ? summaryView(preview) : null}
          {result ? summaryView(result) : null}
          {settings?.last_cleanup_status ? <p className="note">{dictionary.retention.lastCleanup}: {settings.last_cleanup_status}</p> : null}
        </section>
      </section>

      {confirmRun ? (
        <div className="settings-backdrop" role="presentation">
          <section aria-modal="true" className="settings-panel retention-confirm" role="dialog">
            <h2>{dictionary.retention.confirm}</h2>
            <p>{dictionary.retention.confirmWarning}</p>
            {preview ? summaryView(preview) : null}
            <div className="actions">
              <button className="danger-button" disabled={busy} onClick={() => void runCleanup()} type="button">{dictionary.retention.run}</button>
              <button className="secondary-link" disabled={busy} onClick={() => setConfirmRun(false)} type="button">{dictionary.retention.cancel}</button>
            </div>
          </section>
        </div>
      ) : null}
    </main>
  );
}
