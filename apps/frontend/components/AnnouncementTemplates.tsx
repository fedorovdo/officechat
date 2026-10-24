"use client";

import { useEffect, useState } from "react";
import { createBroadcastTemplate, deleteBroadcastTemplate, getBroadcastTemplates, updateBroadcastTemplate,
  type BroadcastPriority, type BroadcastTemplate, type BroadcastTemplatePayload } from "../lib/api";
import type { Dictionary } from "../lib/i18n";
import { AnnouncementEditor } from "./AnnouncementEditor";

export function AnnouncementTemplates({ userId, dictionary, getToken, draft, disabled, onUse }: {
  userId: string; dictionary: Dictionary; getToken: () => string;
  draft: Omit<BroadcastTemplatePayload, "name">; disabled: boolean;
  onUse: (template: BroadcastTemplate) => void;
}) {
  const t = dictionary.announcements.templates;
  const [items, setItems] = useState<BroadcastTemplate[]>([]);
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const [name, setName] = useState("");
  const [editing, setEditing] = useState<BroadcastTemplate | null>(null);
  const [deleteId, setDeleteId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [status, setStatus] = useState("");

  async function load(targetPage = page) {
    const result = await getBroadcastTemplates(getToken(), targetPage);
    if (!result.items.length && targetPage > 1) { setPage(targetPage - 1); return; }
    setItems(result.items); setTotal(result.total);
  }
  useEffect(() => {
    let cancelled = false;
    void getBroadcastTemplates(getToken(), page).then(result => {
      if (!cancelled) { setItems(result.items); setTotal(result.total); setError(""); }
    }).catch(() => { if (!cancelled) setError(t.loadError); });
    return () => { cancelled = true; };
  }, [page, userId]);

  async function save() {
    setBusy(true); setError(""); setStatus("");
    try {
      if (editing) {
        await updateBroadcastTemplate(getToken(), editing.id, {
          name: editing.name, title: editing.title, body: editing.body,
          body_doc: editing.body_doc, priority: editing.priority
        });
      } else { await createBroadcastTemplate(getToken(), { name, ...draft }); }
      setEditing(null); setName(""); setStatus(t.saved);
      await load();
    } catch { setError(t.saveError); }
    finally { setBusy(false); }
  }
  async function remove(id: string) {
    setBusy(true); setError(""); setStatus("");
    try {
      await deleteBroadcastTemplate(getToken(), id);
      if (editing?.id === id) setEditing(null);
      setDeleteId(null); setStatus(t.deleted); await load();
    } catch { setError(t.deleteError); }
    finally { setBusy(false); }
  }
  const locked = disabled || busy;
  const invalid = (value: Omit<BroadcastTemplatePayload, "name">) => !value.title.trim() || !value.body.trim() || value.body.length > 10000;
  return <section className="announcement-templates" aria-label={t.title}>
    <h4>{t.title}</h4>
    {error ? <p className="form-error" role="alert">{error}</p> : null}
    {status ? <p className="form-success" role="status">{status}</p> : null}
    <p className="muted">{t.replaceNotice}</p>
    <label className="field"><span className="field-label">{t.name}</span>
      <input className="field-input" disabled={locked} maxLength={100} value={name} onChange={event => setName(event.target.value)} />
    </label>
    <button className="secondary-link" type="button" disabled={locked || !!editing || !name.trim() || invalid(draft)} onClick={() => void save()}>{t.saveNew}</button>
    {!items.length ? <p className="muted">{t.empty}</p> : null}
    {items.map(item => <div className="announcement-template-item" key={item.id}>
      <div><strong>{item.name}</strong><small>{t.author.replace("{name}", item.created_by_display_name)}</small></div>
      <div className="actions">
        <button className="table-action" type="button" disabled={locked || !!editing} onClick={() => onUse(item)}>{t.use}</button>
        {item.created_by_user_id === userId ? <>
          <button className="table-action" type="button" disabled={locked} onClick={() => { setEditing(structuredClone(item)); setDeleteId(null); }}>{t.edit}</button>
          <button className="table-action" type="button" disabled={locked} onClick={() => setDeleteId(item.id)}>{t.delete}</button>
        </> : null}
        {deleteId === item.id ? <>
          <button className="table-action" type="button" disabled={locked} onClick={() => void remove(item.id)}>{t.confirmDelete}</button>
          <button className="table-action" type="button" disabled={locked} onClick={() => setDeleteId(null)}>{t.cancel}</button>
        </> : null}
      </div>
    </div>)}
    {total > 20 ? <div className="actions">
      <button type="button" disabled={locked || page === 1} onClick={() => setPage(page - 1)}>{t.previous}</button>
      <span>{t.page.replace("{page}", String(page))}</span>
      <button type="button" disabled={locked || page * 20 >= total} onClick={() => setPage(page + 1)}>{t.next}</button>
    </div> : null}
    {editing ? <div className="announcement-template-edit" aria-label={t.editing}>
      <h4>{t.editing}</h4>
      <label className="field"><span>{t.name}</span><input className="field-input" disabled={locked} maxLength={100}
        value={editing.name} onChange={event => setEditing({ ...editing, name: event.target.value })} /></label>
      <label className="field"><span>{dictionary.announcements.fields.title}</span><input className="field-input" disabled={locked} maxLength={160}
        value={editing.title} onChange={event => setEditing({ ...editing, title: event.target.value })} /></label>
      <AnnouncementEditor body={editing.body} document={editing.body_doc} label={dictionary.announcements.fields.body}
        t={dictionary.announcements.editor} disabled={locked}
        onChange={(body, body_doc) => setEditing({ ...editing, body, body_doc })} />
      <label className="field"><span>{dictionary.announcements.fields.priority}</span><select className="field-input" disabled={locked}
        value={editing.priority} onChange={event => setEditing({ ...editing, priority: event.target.value as BroadcastPriority })}>
        {(["normal", "important", "urgent"] as const).map(priority => <option key={priority} value={priority}>{dictionary.announcements.priorities[priority]}</option>)}
      </select></label>
      <div className="actions">
        <button className="primary-button" type="button" disabled={locked || !editing.name.trim() || invalid(editing)} onClick={() => void save()}>{t.save}</button>
        <button className="secondary-link" type="button" disabled={locked} onClick={() => setEditing(null)}>{t.cancel}</button>
      </div>
    </div> : null}
  </section>;
}
