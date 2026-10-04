"use client";

import { FormEvent, useEffect, useState } from "react";

import {
  getBackupSettings, getBackupSettingsJob, getLatestBackupSettingsJob,
  getLocalizedApiError, requireStoredAccessToken, updateBackupSettings,
  type BackupScheduleSettings, type BackupSettings, type BackupSettingsJob,
  type BackupSettingsUpdate, type OfficeChatBackupStatus
} from "../lib/api";
import type { Dictionary, Locale } from "../lib/i18n";
import { AdminCard } from "./AdminUI";

const DAYS: BackupScheduleSettings["days"] = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

export function AdminBackupSettings({ dictionary, locale, canManage, status, onSaved }: {
  dictionary: Dictionary; locale: Locale; canManage: boolean;
  status: OfficeChatBackupStatus | null; onSaved: () => void;
}) {
  const text = dictionary.backups.settings;
  const [current, setCurrent] = useState<BackupSettings | null>(null);
  const [job, setJob] = useState<BackupSettingsJob | null>(null);
  const [kind, setKind] = useState<"local" | "unchanged" | "nfs" | "smb">("local");
  const [host, setHost] = useState("");
  const [exportPath, setExportPath] = useState("");
  const [nfsVersion, setNfsVersion] = useState<"3" | "4.1" | "4.2">("4.1");
  const [share, setShare] = useState("");
  const [directory, setDirectory] = useState("");
  const [domain, setDomain] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [requireOffsite, setRequireOffsite] = useState(false);
  const [schedule, setSchedule] = useState<BackupScheduleSettings>({ enabled: false, days: DAYS, time: "02:30" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [changing, setChanging] = useState(false);
  const [confirmChange, setConfirmChange] = useState(false);

  useEffect(() => {
    const token = requireStoredAccessToken(locale);
    if (!token) return;
    void Promise.all([getBackupSettings(token), getLatestBackupSettingsJob(token)]).then(([settings, last]) => {
      setCurrent(settings);
      setSchedule({ ...settings.schedule, days: settings.schedule.days.length ? settings.schedule.days : DAYS });
      setKind(settings.destination.kind === "local" ? "local" : "unchanged");
      setJob(last.request);
    }).catch((caught) => setError(getLocalizedApiError(caught, dictionary.session)));
  }, [dictionary.session, locale]);

  useEffect(() => {
    if (!job || !["queued", "running"].includes(job.state)) return;
    const interval = window.setInterval(() => {
      const token = requireStoredAccessToken(locale);
      if (!token) return;
      void getBackupSettingsJob(token, job.request_id).then(async (updated) => {
        setJob(updated);
        if (updated.state === "succeeded") {
          const settings = await getBackupSettings(token);
          setCurrent(settings);
          setSchedule(settings.schedule);
          setKind(settings.destination.kind === "local" ? "local" : "unchanged");
          setChanging(false);
          setConfirmChange(false);
          onSaved();
        }
      }).catch((caught) => setError(getLocalizedApiError(caught, dictionary.session)));
    }, 3000);
    return () => window.clearInterval(interval);
  }, [dictionary.session, job, locale, onSaved]);

  async function save(event: FormEvent) {
    event.preventDefault();
    const token = requireStoredAccessToken(locale);
    if (!token || !canManage || busy || !current) return;
    if (changing && !confirmChange) return;
    if (!changing && schedule.enabled && (status?.last_success?.verification_status !== "passed" ||
        ((kind === "nfs" || kind === "smb") ||
        (current.destination.kind !== "local" && status?.last_success?.offsite_status !== "copied")))) {
      setError(text.verifyFirst);
      return;
    }
    setBusy(true);
    setError("");
    let destination: BackupSettingsUpdate["destination"];
    if (kind === "nfs") destination = { kind, host: host.trim(), export: exportPath.trim(), version: nfsVersion, require_offsite: requireOffsite };
    else if (kind === "smb") destination = { kind, host: host.trim(), share: share.trim(), directory: directory.trim(), domain: domain.trim(), username: username.trim(), password, require_offsite: requireOffsite };
    else destination = { kind };
    if (changing && (destination.kind === "smb" || destination.kind === "nfs")) destination.replace_existing = true;
    try {
      setJob(await updateBackupSettings(token, { destination, schedule: changing ? current.schedule : schedule }));
      setPassword("");
    } catch (caught) {
      setError(getLocalizedApiError(caught, dictionary.session));
    } finally {
      setBusy(false);
    }
  }

  function changeStorage() {
    if (!current || (current.destination.kind !== "smb" && current.destination.kind !== "nfs")) return;
    const saved = current.destination;
    setChanging(true);
    setConfirmChange(false);
    setKind(saved.kind);
    setHost(saved.host);
    setRequireOffsite(saved.require_offsite);
    setSchedule(current.schedule);
    setPassword("");
    setError("");
    if (saved.kind === "smb") {
      setShare(saved.share); setDirectory(saved.directory ?? "");
      setDomain(saved.domain); setUsername(saved.username);
    } else { setExportPath(saved.export); setNfsVersion(saved.version); }
  }

  async function reconnect() {
    const token = requireStoredAccessToken(locale);
    if (!token || !canManage || busy || !current) return;
    setBusy(true);
    setError("");
    try {
      setJob(await updateBackupSettings(token, {
        destination: { kind: "reconnect" }, schedule: current.schedule
      }));
    } catch (caught) {
      setError(getLocalizedApiError(caught, dictionary.session));
    } finally {
      setBusy(false);
    }
  }

  const active = Boolean(job && ["queued", "running"].includes(job.state));
  const configured = Boolean(current && current.destination.kind !== "local" && current.destination.kind !== "unmanaged");
  return <AdminCard title={text.title} description={text.description}>
    {error ? <p className="form-error">{error}</p> : null}
    {job ? <p className={job.state === "failed" ? "form-error" : "note"}>{text.job}: {job.error_code === "MOUNT_HELPER_MISSING" ? text.mountHelperMissing : job.error_code === "STORAGE_ROLLBACK_FAILED" ? text.rollbackFailed : job.error_code === "STORAGE_MIGRATION_FAILED" ? text.migrationFailed : job.phase && ["queued", "running"].includes(job.state) ? text.phases[job.phase] : text.states[job.state]}</p> : null}
    {job?.backup_id ? <p className="note">{text.migrationBackup}: <code>{job.backup_id}</code></p> : null}
    <p>{text.current}: <strong>{current ? text.destinations[current.destination.kind] : text.loading}</strong></p>
    {current?.destination.kind === "nfs" ? <p><code>{current.destination.host}:{current.destination.export}</code></p> : null}
    {current?.destination.kind === "smb" ? <p><code>//{current.destination.host}/{current.destination.share}{current.destination.directory ? `/${current.destination.directory}` : ""}</code></p> : null}
    {configured ? <>
      <p className={status?.offsite.mounted === false ? "form-error" : "note"}>
        {text.connection}: {status?.offsite.mounted === true ? text.mounted : status?.offsite.mounted === false ? text.unmounted : text.mountUnknown}
      </p>
      {canManage ? <>
        <button className="admin-button admin-button-secondary" disabled={busy || active || changing} onClick={() => void reconnect()} type="button">{text.reconnect}</button>
        <button className="admin-button admin-button-secondary" disabled={busy || active || changing} onClick={changeStorage} type="button">{text.changeStorage}</button>
      </> : null}
      <p className="note">{text.reconnectNote}</p>
      <p className="note">{text.migration}</p>
    </> : null}
    <form onSubmit={(event) => void save(event)}>
      {canManage ? <>
        {changing ? <p className="note">{text.changeWarning}</p> : null}
        <label>{text.destination}<select className="field-input" disabled={active || (configured && !changing) || current?.destination.kind === "unmanaged"} onChange={(event) => setKind(event.target.value as typeof kind)} value={kind}>
          {current?.destination.kind === "unmanaged" || (configured && !changing) ? <option value="unchanged">{text.keepDestination}</option> : <>
            {!changing ? <option value="local">{text.destinations.local}</option> : null}<option value="nfs">NFS</option><option value="smb">SMB / Windows</option>
          </>}
        </select></label>
        {kind === "nfs" || kind === "smb" ? <label>{text.host}<input className="field-input" required maxLength={253} value={host} onChange={(event) => setHost(event.target.value)} /></label> : null}
        {kind === "nfs" ? <><label>{text.export}<input className="field-input" required value={exportPath} onChange={(event) => setExportPath(event.target.value)} placeholder="/export/officechat" /></label><label>{text.nfsVersion}<select className="field-input" value={nfsVersion} onChange={(event) => setNfsVersion(event.target.value as typeof nfsVersion)}><option>4.1</option><option>4.2</option><option>3</option></select></label></> : null}
        {kind === "smb" ? <><label>{text.share}<input className="field-input" required value={share} onChange={(event) => setShare(event.target.value)} /></label><label>{text.directory}<input className="field-input" placeholder="OfficeChat" maxLength={255} value={directory} onChange={(event) => setDirectory(event.target.value)} /></label><label>{text.domain}<input className="field-input" value={domain} onChange={(event) => setDomain(event.target.value)} /></label><label>{text.username}<input className="field-input" required value={username} onChange={(event) => setUsername(event.target.value)} /></label><label>{text.password}<input className="field-input" type="password" required autoComplete="new-password" value={password} onChange={(event) => setPassword(event.target.value)} /></label></> : null}
        {kind === "nfs" || kind === "smb" ? <label className="checkbox-row"><input checked={requireOffsite} type="checkbox" onChange={(event) => setRequireOffsite(event.target.checked)} />{text.requireOffsite}</label> : null}
        <p className="note">{text.localFirst}</p>
        <label className="checkbox-row"><input disabled={changing || active} checked={schedule.enabled} type="checkbox" onChange={(event) => setSchedule({ ...schedule, enabled: event.target.checked })} />{text.enable}</label>
        <fieldset disabled={changing || active}><legend>{text.days}</legend>{DAYS.map((day, index) => <label className="checkbox-row" key={day}><input type="checkbox" checked={schedule.days.includes(day)} onChange={(event) => setSchedule({ ...schedule, days: event.target.checked ? [...schedule.days, day] : schedule.days.filter((item) => item !== day) })} />{text.weekdays[index]}</label>)}</fieldset>
        <label>{text.time}<input disabled={changing || active} className="field-input" type="time" value={schedule.time} onChange={(event) => setSchedule({ ...schedule, time: event.target.value })} /></label>
        <p className="note">{text.serverTime}</p>
        {changing ? <label className="checkbox-row"><input type="checkbox" disabled={active} checked={confirmChange} onChange={(event) => setConfirmChange(event.target.checked)} />{text.confirmChange}</label> : null}
        <button className="admin-button" disabled={busy || active || !current || schedule.days.length === 0 || (changing && !confirmChange)} type="submit">{busy ? text.saving : changing ? text.changeSave : text.save}</button>
        {changing ? <button className="admin-button admin-button-secondary" disabled={busy || active} type="button" onClick={() => { setChanging(false); setConfirmChange(false); setPassword(""); setKind("unchanged"); }}>{text.cancelChange}</button> : null}
      </> : <p className="note">{text.superadminOnly}</p>}
    </form>
  </AdminCard>;
}
