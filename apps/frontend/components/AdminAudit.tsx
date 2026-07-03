"use client";

import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";

import {
  downloadAuditCsv,
  getAuditEvent,
  getAuditEvents,
  getAuditFilters,
  getCurrentUser,
  getLocalizedApiError,
  isAdminRole,
  requireStoredAccessToken,
  type AuditEvent,
  type AuditFilterOptions,
  type AuditQuery
} from "../lib/api";
import type { Dictionary, Locale } from "../lib/i18n";

type AdminAuditProps = { dictionary: Dictionary; locale: Locale };
const emptyFilters: AuditQuery = { page: 1, limit: 50 };

export function AdminAudit({ dictionary, locale }: AdminAuditProps) {
  const [filters, setFilters] = useState<AuditQuery>(emptyFilters);
  const [draft, setDraft] = useState<AuditQuery>(emptyFilters);
  const [options, setOptions] = useState<AuditFilterOptions>({ categories: [], statuses: [], event_types: [] });
  const [events, setEvents] = useState<AuditEvent[]>([]);
  const [selected, setSelected] = useState<AuditEvent | null>(null);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const formatter = useMemo(
    () => new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "medium" }),
    [locale]
  );

  const load = useCallback(async (query: AuditQuery) => {
    const token = requireStoredAccessToken(locale);
    if (!token) return;
    setLoading(true);
    setError("");
    try {
      const currentUser = await getCurrentUser(token);
      if (!isAdminRole(currentUser.role)) {
        setError(dictionary.audit.accessDenied);
        return;
      }
      const [page, filterOptions] = await Promise.all([getAuditEvents(token, query), getAuditFilters(token)]);
      setEvents(page.items);
      setTotal(page.total);
      setOptions(filterOptions);
    } catch (caughtError) {
      setError(getLocalizedApiError(caughtError, dictionary.session));
    } finally {
      setLoading(false);
    }
  }, [dictionary.audit.accessDenied, dictionary.session, locale]);

  useEffect(() => { void load(filters); }, [filters, load]);

  function applyFilters(event: FormEvent) {
    event.preventDefault();
    setFilters({ ...draft, page: 1, limit: 50 });
  }

  async function openDetails(eventId: string) {
    const token = requireStoredAccessToken(locale);
    if (!token) return;
    try {
      setSelected(await getAuditEvent(token, eventId));
    } catch (caughtError) {
      setError(getLocalizedApiError(caughtError, dictionary.session));
    }
  }

  async function exportCsv() {
    const token = requireStoredAccessToken(locale);
    if (!token) return;
    try {
      const blob = await downloadAuditCsv(token, { ...filters, page: undefined, limit: undefined });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = "officechat-audit.csv";
      anchor.click();
      URL.revokeObjectURL(url);
    } catch (caughtError) {
      setError(getLocalizedApiError(caughtError, dictionary.session));
    }
  }

  const pages = Math.max(1, Math.ceil(total / Number(filters.limit ?? 50)));

  return (
    <main className="dashboard admin-audit-page">
      <section className="dashboard-shell admin-audit-shell">
        <div className="dashboard-header">
          <div><p className="eyebrow">OfficeChat</p><h1 className="dashboard-title">{dictionary.audit.title}</h1></div>
          <Link className="secondary-link" href={`/${locale}/dashboard`}>{dictionary.audit.back}</Link>
        </div>
        {error ? <p className="form-error">{error}</p> : null}

        <form className="audit-filters" onSubmit={applyFilters}>
          <label>{dictionary.audit.periodFrom}<input className="field-input" onChange={(e) => setDraft({...draft, date_from: e.target.value ? new Date(e.target.value).toISOString() : ""})} type="datetime-local" /></label>
          <label>{dictionary.audit.periodTo}<input className="field-input" onChange={(e) => setDraft({...draft, date_to: e.target.value ? new Date(e.target.value).toISOString() : ""})} type="datetime-local" /></label>
          <label>{dictionary.audit.category}<select className="field-input" onChange={(e) => setDraft({...draft, category: e.target.value})} value={draft.category ?? ""}><option value="">{dictionary.audit.all}</option>{options.categories.map((value) => <option key={value}>{value}</option>)}</select></label>
          <label>{dictionary.audit.eventType}<select className="field-input" onChange={(e) => setDraft({...draft, event_type: e.target.value})} value={draft.event_type ?? ""}><option value="">{dictionary.audit.all}</option>{options.event_types.map((value) => <option key={value}>{value}</option>)}</select></label>
          <label>{dictionary.audit.status}<select className="field-input" onChange={(e) => setDraft({...draft, status: e.target.value})} value={draft.status ?? ""}><option value="">{dictionary.audit.all}</option>{options.statuses.map((value) => <option key={value}>{value}</option>)}</select></label>
          <label>{dictionary.audit.actor}<input className="field-input" onChange={(e) => setDraft({...draft, actor_username: e.target.value})} value={draft.actor_username ?? ""} /></label>
          <label>{dictionary.audit.target}<input className="field-input" onChange={(e) => setDraft({...draft, target_id: e.target.value})} value={draft.target_id ?? ""} /></label>
          <label>{dictionary.audit.search}<input className="field-input" onChange={(e) => setDraft({...draft, search: e.target.value})} value={draft.search ?? ""} /></label>
          <div className="actions"><button className="primary-button" type="submit">{dictionary.audit.apply}</button><button className="secondary-link" onClick={() => { setDraft(emptyFilters); setFilters(emptyFilters); }} type="button">{dictionary.audit.reset}</button><button className="secondary-link" onClick={() => void exportCsv()} type="button">{dictionary.audit.export}</button></div>
        </form>

        <div className="admin-table-wrap audit-table-wrap">
          <table className="admin-table"><thead><tr><th>{dictionary.audit.time}</th><th>{dictionary.audit.status}</th><th>{dictionary.audit.action}</th><th>{dictionary.audit.actor}</th><th>{dictionary.audit.target}</th><th>{dictionary.audit.sourceIp}</th><th /></tr></thead>
          <tbody>{events.map((event) => <tr key={event.id}><td>{formatter.format(new Date(event.created_at))}</td><td><span className={`audit-status audit-status-${event.status}`}>{event.status}</span></td><td><strong>{event.event_type}</strong><small>{event.category}</small></td><td>{event.actor_username ?? dictionary.audit.system}</td><td>{event.target_label ?? event.target_id ?? "-"}</td><td>{event.source_ip ?? "-"}</td><td><button className="secondary-link" onClick={() => void openDetails(event.id)} type="button">{dictionary.audit.details}</button></td></tr>)}</tbody></table>
          {!loading && events.length === 0 ? <p className="sidebar-empty-state">{dictionary.audit.empty}</p> : null}
          {loading ? <p className="muted">{dictionary.audit.loading}</p> : null}
        </div>
        <div className="audit-pagination"><button className="secondary-link" disabled={(filters.page ?? 1) <= 1} onClick={() => setFilters({...filters, page: (filters.page ?? 1) - 1})} type="button">{dictionary.audit.previous}</button><span>{filters.page ?? 1} / {pages}</span><button className="secondary-link" disabled={(filters.page ?? 1) >= pages} onClick={() => setFilters({...filters, page: (filters.page ?? 1) + 1})} type="button">{dictionary.audit.next}</button></div>
      </section>

      {selected ? <div className="settings-backdrop" role="presentation"><section aria-modal="true" className="settings-panel audit-details" role="dialog"><div className="dashboard-header"><h2>{dictionary.audit.eventDetails}</h2><button className="secondary-link" onClick={() => setSelected(null)} type="button">{dictionary.audit.close}</button></div><dl><dt>{dictionary.audit.eventType}</dt><dd>{selected.event_type}</dd><dt>{dictionary.audit.requestId}</dt><dd>{selected.request_id ?? "-"}</dd><dt>{dictionary.audit.actor}</dt><dd>{selected.actor_display_name ?? selected.actor_username ?? dictionary.audit.system} ({selected.actor_role ?? "-"})</dd><dt>{dictionary.audit.target}</dt><dd>{selected.target_type ?? "-"}: {selected.target_label ?? selected.target_id ?? "-"}</dd><dt>{dictionary.audit.userAgent}</dt><dd>{selected.user_agent ?? "-"}</dd>{selected.error_message ? <><dt>{dictionary.audit.error}</dt><dd>{selected.error_code}: {selected.error_message}</dd></> : null}</dl><h3>{dictionary.audit.details}</h3><div className="audit-detail-values">{Object.entries(selected.details ?? {}).map(([key, value]) => <div key={key}><strong>{key}</strong><pre>{typeof value === "string" ? value : JSON.stringify(value, null, 2)}</pre></div>)}</div></section></div> : null}
    </main>
  );
}
