"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";

import {
  archiveDirectoryEntry,
  createDirectoryEntry,
  getDirectoryDepartments,
  getDirectoryEntries,
  getStoredAccessToken,
  hasPermission,
  restoreDirectoryEntry,
  updateDirectoryEntry,
  type DirectoryEntryPayload,
  type OfficeChatDirectoryEntry,
  type OfficeChatDirectoryLinkedUser,
  type OfficeChatDirectoryUser,
  type OfficeChatUser
} from "../lib/api";
import type { Dictionary, Locale } from "../lib/i18n";
import { DirectoryImportWizard } from "./DirectoryImportWizard";

type DirectoryPanelProps = {
  currentUser: OfficeChatUser;
  dictionary: Dictionary;
  locale: Locale;
  onBack: () => void;
  onStartDirect: (userId: string) => void;
  users: OfficeChatDirectoryUser[];
};

type DirectoryForm = {
  display_name: string;
  department: string;
  position: string;
  internal_phone: string;
  work_phone: string;
  mobile_phone: string;
  email: string;
  room: string;
  location: string;
  notes: string;
  linked_user_id: string;
};

const pageSize = 30;

function emptyDirectoryForm(): DirectoryForm {
  return {
    display_name: "",
    department: "",
    position: "",
    internal_phone: "",
    work_phone: "",
    mobile_phone: "",
    email: "",
    room: "",
    location: "",
    notes: "",
    linked_user_id: ""
  };
}

function formFromEntry(entry: OfficeChatDirectoryEntry): DirectoryForm {
  return {
    display_name: entry.display_name,
    department: entry.department ?? "",
    position: entry.position ?? "",
    internal_phone: entry.internal_phone ?? "",
    work_phone: entry.work_phone ?? "",
    mobile_phone: entry.mobile_phone ?? "",
    email: entry.email ?? "",
    room: entry.room ?? "",
    location: entry.location ?? "",
    notes: entry.notes ?? "",
    linked_user_id: entry.linked_user_id ?? ""
  };
}

function formPayload(form: DirectoryForm): DirectoryEntryPayload {
  const optional = (value: string) => value.trim() || null;
  return {
    display_name: form.display_name.trim(),
    department: optional(form.department),
    position: optional(form.position),
    internal_phone: optional(form.internal_phone),
    work_phone: optional(form.work_phone),
    mobile_phone: optional(form.mobile_phone),
    email: optional(form.email),
    room: optional(form.room),
    location: optional(form.location),
    notes: optional(form.notes),
    linked_user_id: form.linked_user_id || null
  };
}

function telephoneHref(value: string) {
  return `tel:${value.replace(/[^\d+]/g, "")}`;
}

function ContactLinks({ entry, labels }: { entry: OfficeChatDirectoryEntry; labels: Dictionary["directory"] }) {
  const phones = [
    [labels.fields.internalPhone, entry.internal_phone],
    [labels.fields.workPhone, entry.work_phone],
    [labels.fields.mobilePhone, entry.mobile_phone]
  ].filter((item): item is [string, string] => Boolean(item[1]));
  return (
    <div className="directory-contact-links">
      {phones.map(([label, value]) => (
        <a href={telephoneHref(value)} key={`${label}-${value}`} title={label}>{value}</a>
      ))}
      {entry.email ? <a href={`mailto:${entry.email}`}>{entry.email}</a> : null}
    </div>
  );
}

function LinkedUserIndicator({
  currentUserId,
  labels,
  linkedUser
}: {
  currentUserId: string;
  labels: Dictionary["directory"];
  linkedUser: OfficeChatDirectoryLinkedUser;
}) {
  return (
    <span className="directory-linked-user">
      {labels.officeChatUser.replace("{username}", linkedUser.username)}
      {linkedUser.id === currentUserId ? <em>{labels.thisIsYou}</em> : null}
      {!linkedUser.is_active ? <em>{labels.accountDisabled}</em> : null}
    </span>
  );
}

export function DirectoryPanel({
  currentUser,
  dictionary,
  locale,
  onBack,
  onStartDirect,
  users
}: DirectoryPanelProps) {
  const t = dictionary.directory;
  const canManage = hasPermission(currentUser, "can_manage_directory");
  const [entries, setEntries] = useState<OfficeChatDirectoryEntry[]>([]);
  const [departments, setDepartments] = useState<string[]>([]);
  const [searchInput, setSearchInput] = useState("");
  const [search, setSearch] = useState("");
  const [department, setDepartment] = useState("");
  const [statusFilter, setStatusFilter] = useState<"active" | "all">("active");
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const [selectedEntry, setSelectedEntry] = useState<OfficeChatDirectoryEntry | null>(null);
  const [editingEntry, setEditingEntry] = useState<OfficeChatDirectoryEntry | null>(null);
  const [form, setForm] = useState<DirectoryForm>(emptyDirectoryForm);
  const [isEditorOpen, setIsEditorOpen] = useState(false);
  const [isImportOpen, setIsImportOpen] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [actionEntryId, setActionEntryId] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const entriesRequestId = useRef(0);
  const departmentsRequestId = useRef(0);

  const managerUsers = useMemo(
    () => users.filter((user) => user.role !== "bot").sort((a, b) => a.display_name.localeCompare(b.display_name, locale)),
    [locale, users]
  );
  const totalPages = Math.max(1, Math.ceil(total / pageSize));

  const loadEntries = useCallback(async () => {
    const token = getStoredAccessToken();
    if (!token) return;
    const requestId = ++entriesRequestId.current;
    setIsLoading(true);
    setError("");
    try {
      const result = await getDirectoryEntries(token, {
        search: search || undefined,
        department: department || undefined,
        status: canManage ? statusFilter : "active",
        page,
        limit: pageSize
      });
      if (requestId !== entriesRequestId.current) return;
      const resultPages = Math.max(1, Math.ceil(result.total / pageSize));
      if (page > resultPages) {
        setPage(resultPages);
        return;
      }
      setEntries(result.items);
      setTotal(result.total);
      setSelectedEntry((current) => {
        if (!current) return null;
        return result.items.find((entry) => entry.id === current.id) ?? current;
      });
    } catch {
      if (requestId !== entriesRequestId.current) return;
      setEntries([]);
      setTotal(0);
      setError(t.loadError);
    } finally {
      if (requestId === entriesRequestId.current) setIsLoading(false);
    }
  }, [canManage, department, page, search, statusFilter, t.loadError]);

  const loadDepartments = useCallback(async () => {
    const token = getStoredAccessToken();
    if (!token) return;
    const requestId = ++departmentsRequestId.current;
    try {
      const result = await getDirectoryDepartments(token, canManage && statusFilter === "all");
      if (requestId !== departmentsRequestId.current) return;
      setDepartments(result.items);
    } catch {
      if (requestId === departmentsRequestId.current) setDepartments([]);
    }
  }, [canManage, statusFilter]);

  useEffect(() => {
    void loadEntries();
  }, [loadEntries]);

  useEffect(() => {
    void loadDepartments();
  }, [loadDepartments]);

  function submitSearch(event: FormEvent) {
    event.preventDefault();
    setPage(1);
    setSearch(searchInput.trim());
  }

  function resetFilters() {
    setSearchInput("");
    setSearch("");
    setDepartment("");
    setStatusFilter("active");
    setPage(1);
  }

  function openCreate() {
    setEditingEntry(null);
    setForm(emptyDirectoryForm());
    setError("");
    setMessage("");
    setIsEditorOpen(true);
  }

  function openEdit(entry: OfficeChatDirectoryEntry) {
    setSelectedEntry(null);
    setEditingEntry(entry);
    setForm(formFromEntry(entry));
    setError("");
    setMessage("");
    setIsEditorOpen(true);
  }

  async function saveEntry(event: FormEvent) {
    event.preventDefault();
    const token = getStoredAccessToken();
    if (!token) return;
    setIsSaving(true);
    setError("");
    setMessage("");
    try {
      const saved = editingEntry
        ? await updateDirectoryEntry(token, editingEntry.id, formPayload(form))
        : await createDirectoryEntry(token, formPayload(form));
      setSelectedEntry(saved);
      setIsEditorOpen(false);
      setMessage(editingEntry ? t.updateSuccess : t.createSuccess);
      await Promise.all([loadEntries(), loadDepartments()]);
    } catch {
      setError(t.saveError);
    } finally {
      setIsSaving(false);
    }
  }

  async function toggleArchive(entry: OfficeChatDirectoryEntry) {
    const confirmation = entry.is_active ? t.archiveConfirm : t.restoreConfirm;
    if (!window.confirm(confirmation)) return;
    const token = getStoredAccessToken();
    if (!token) return;
    setActionEntryId(entry.id);
    setError("");
    setMessage("");
    try {
      const updated = entry.is_active
        ? await archiveDirectoryEntry(token, entry.id)
        : await restoreDirectoryEntry(token, entry.id);
      setSelectedEntry(updated);
      setMessage(entry.is_active ? t.archiveSuccess : t.restoreSuccess);
      await Promise.all([loadEntries(), loadDepartments()]);
    } catch {
      setError(t.actionError);
    } finally {
      setActionEntryId(null);
    }
  }

  function resolveLinkedUser(entry: OfficeChatDirectoryEntry): OfficeChatDirectoryLinkedUser | null {
    return entry.linked_user ?? users.find((user) => user.id === entry.linked_user_id) ?? null;
  }

  function canMessage(entry: OfficeChatDirectoryEntry) {
    const linkedUser = resolveLinkedUser(entry);
    const directTarget = linkedUser
      ? users.find((user) => user.id === linkedUser.id && user.role !== "bot")
      : null;
    return Boolean(directTarget?.is_active && directTarget.id !== currentUser.id);
  }

  function startDirect(entry: OfficeChatDirectoryEntry) {
    const linkedUser = resolveLinkedUser(entry);
    if (linkedUser && canMessage(entry)) onStartDirect(linkedUser.id);
  }

  return (
    <div className="directory-panel">
      <header className="user-app-chat-heading directory-heading">
        <button className="mobile-chat-back" onClick={onBack} type="button">{dictionary.appShell.backToChats}</button>
        <div>
          <p className="eyebrow">{t.eyebrow}</p>
          <h2 className="section-title">{t.title}</h2>
          <p className="admin-current">{t.subtitle}</p>
        </div>
        {canManage ? (
          <div className="directory-heading-actions">
            <button className="secondary-link" onClick={() => setIsImportOpen(true)} type="button">
              {dictionary.directoryImport.open}
            </button>
            <button className="primary-button" onClick={openCreate} type="button">{t.add}</button>
          </div>
        ) : null}
      </header>

      <div className="directory-content">
        {error ? <p className="form-error">{error}</p> : null}
        {message ? <p className="form-success">{message}</p> : null}
        <form className="directory-filters" onSubmit={submitSearch}>
          <label className="field">
            <span className="field-label">{t.search}</span>
            <input
              className="field-input"
              onChange={(event) => setSearchInput(event.target.value)}
              placeholder={t.searchPlaceholder}
              type="search"
              value={searchInput}
            />
          </label>
          <label className="field">
            <span className="field-label">{t.department}</span>
            <select
              className="field-input"
              onChange={(event) => { setDepartment(event.target.value); setPage(1); }}
              value={department}
            >
              <option value="">{t.allDepartments}</option>
              {departments.map((item) => <option key={item} value={item}>{item}</option>)}
            </select>
          </label>
          {canManage ? (
            <label className="field">
              <span className="field-label">{t.activity}</span>
              <select
                className="field-input"
                onChange={(event) => { setStatusFilter(event.target.value as "active" | "all"); setPage(1); }}
                value={statusFilter}
              >
                <option value="active">{t.activeOnly}</option>
                <option value="all">{t.allEntries}</option>
              </select>
            </label>
          ) : null}
          <div className="directory-filter-actions">
            <button className="primary-button" type="submit">{t.apply}</button>
            <button className="secondary-link" onClick={resetFilters} type="button">{t.reset}</button>
          </div>
        </form>

        {isLoading ? <p className="muted" role="status">{t.loading}</p> : null}
        {!isLoading && !error && entries.length === 0 ? <div className="directory-empty"><strong>{t.empty}</strong><p>{t.emptyHint}</p></div> : null}

        {!isLoading && entries.length > 0 ? (
          <>
            <div className="directory-table-wrap">
              <table className="directory-table">
                <thead>
                  <tr>
                    <th>{t.fields.displayName}</th>
                    <th>{t.organization}</th>
                    <th>{t.contacts}</th>
                    <th>{t.place}</th>
                    <th>{t.actions}</th>
                  </tr>
                </thead>
                <tbody>
                  {entries.map((entry) => (
                    <tr className={entry.is_active ? "" : "directory-entry-inactive"} key={entry.id}>
                      <td>
                        <strong>{entry.display_name}</strong>
                        {resolveLinkedUser(entry) ? (
                          <LinkedUserIndicator
                            currentUserId={currentUser.id}
                            labels={t}
                            linkedUser={resolveLinkedUser(entry)!}
                          />
                        ) : null}
                      </td>
                      <td><span>{entry.position || t.emptyValue}</span><small>{entry.department || t.emptyValue}</small></td>
                      <td><ContactLinks entry={entry} labels={t} /></td>
                      <td><span>{entry.room || t.emptyValue}</span><small>{entry.location || t.emptyValue}</small></td>
                      <td>
                        <div className="directory-row-actions">
                          <button className="table-action" onClick={() => setSelectedEntry(entry)} type="button">{t.open}</button>
                          {canMessage(entry) ? <button className="table-action" onClick={() => startDirect(entry)} type="button">{t.message}</button> : null}
                          {canManage ? <button className="table-action" onClick={() => openEdit(entry)} type="button">{t.edit}</button> : null}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="directory-cards">
              {entries.map((entry) => (
                <article className={entry.is_active ? "directory-card" : "directory-card directory-entry-inactive"} key={entry.id}>
                  <button className="directory-card-open" onClick={() => setSelectedEntry(entry)} type="button">
                    <strong>{entry.display_name}</strong>
                    <span>{[entry.position, entry.department].filter(Boolean).join(" · ") || t.emptyValue}</span>
                    {resolveLinkedUser(entry) ? (
                      <LinkedUserIndicator
                        currentUserId={currentUser.id}
                        labels={t}
                        linkedUser={resolveLinkedUser(entry)!}
                      />
                    ) : null}
                  </button>
                  <ContactLinks entry={entry} labels={t} />
                  <small>{[entry.room, entry.location].filter(Boolean).join(" · ") || t.emptyValue}</small>
                  <div className="directory-row-actions">
                    {canMessage(entry) ? <button className="table-action" onClick={() => startDirect(entry)} type="button">{t.message}</button> : null}
                    {canManage ? <button className="table-action" onClick={() => openEdit(entry)} type="button">{t.edit}</button> : null}
                  </div>
                </article>
              ))}
            </div>
            <div className="directory-pagination">
              <span>{t.page.replace("{page}", String(page)).replace("{pages}", String(totalPages)).replace("{total}", String(total))}</span>
              <div>
                <button className="secondary-link" disabled={page <= 1} onClick={() => setPage((value) => value - 1)} type="button">{t.previous}</button>
                <button className="secondary-link" disabled={page >= totalPages} onClick={() => setPage((value) => value + 1)} type="button">{t.next}</button>
              </div>
            </div>
          </>
        ) : null}
      </div>

      {selectedEntry ? (
        <div className="modal-backdrop" role="presentation">
          <section aria-label={selectedEntry.display_name} aria-modal="true" className="directory-detail-panel" role="dialog">
            <header className="dashboard-header">
              <div>
                <p className="eyebrow">{t.contact}</p>
                <h3>{selectedEntry.display_name}</h3>
                {!selectedEntry.is_active ? <span className="status-badge status-inactive">{t.archived}</span> : null}
              </div>
              <button className="table-action" onClick={() => setSelectedEntry(null)} type="button">{t.close}</button>
            </header>
            <dl className="directory-detail-list">
              <dt>{t.fields.position}</dt><dd>{selectedEntry.position || t.emptyValue}</dd>
              <dt>{t.fields.department}</dt><dd>{selectedEntry.department || t.emptyValue}</dd>
              <dt>{t.fields.internalPhone}</dt><dd>{selectedEntry.internal_phone ? <a href={telephoneHref(selectedEntry.internal_phone)}>{selectedEntry.internal_phone}</a> : t.emptyValue}</dd>
              <dt>{t.fields.workPhone}</dt><dd>{selectedEntry.work_phone ? <a href={telephoneHref(selectedEntry.work_phone)}>{selectedEntry.work_phone}</a> : t.emptyValue}</dd>
              <dt>{t.fields.mobilePhone}</dt><dd>{selectedEntry.mobile_phone ? <a href={telephoneHref(selectedEntry.mobile_phone)}>{selectedEntry.mobile_phone}</a> : t.emptyValue}</dd>
              <dt>{t.fields.email}</dt><dd>{selectedEntry.email ? <a href={`mailto:${selectedEntry.email}`}>{selectedEntry.email}</a> : t.emptyValue}</dd>
              <dt>{t.fields.room}</dt><dd>{selectedEntry.room || t.emptyValue}</dd>
              <dt>{t.fields.location}</dt><dd>{selectedEntry.location || t.emptyValue}</dd>
              <dt>{t.fields.notes}</dt><dd className="directory-notes">{selectedEntry.notes || t.emptyValue}</dd>
              <dt>{t.fields.linkedUser}</dt>
              <dd>
                {resolveLinkedUser(selectedEntry) ? (
                  <span className="directory-linked-user-detail">
                    {t.linkedUserSummary
                      .replace("{displayName}", resolveLinkedUser(selectedEntry)!.display_name)
                      .replace("{username}", resolveLinkedUser(selectedEntry)!.username)}
                    {resolveLinkedUser(selectedEntry)!.id === currentUser.id ? <em>{t.thisIsYou}</em> : null}
                    {!resolveLinkedUser(selectedEntry)!.is_active ? <em>{t.accountDisabled}</em> : null}
                  </span>
                ) : t.noLinkedUser}
              </dd>
            </dl>
            <div className="actions">
              {canMessage(selectedEntry) ? <button className="primary-button" onClick={() => startDirect(selectedEntry)} type="button">{t.messageInOfficeChat}</button> : null}
              {canManage ? <button className="secondary-link" onClick={() => openEdit(selectedEntry)} type="button">{t.edit}</button> : null}
              {canManage ? (
                <button
                  className="secondary-link"
                  disabled={actionEntryId === selectedEntry.id}
                  onClick={() => void toggleArchive(selectedEntry)}
                  type="button"
                >
                  {selectedEntry.is_active ? t.archive : t.restore}
                </button>
              ) : null}
            </div>
          </section>
        </div>
      ) : null}

      {isEditorOpen ? (
        <div className="modal-backdrop" role="presentation">
          <form aria-label={editingEntry ? t.editTitle : t.createTitle} aria-modal="true" className="directory-editor" onSubmit={saveEntry} role="dialog">
            <header className="dashboard-header">
              <h3>{editingEntry ? t.editTitle : t.createTitle}</h3>
              <button className="table-action" disabled={isSaving} onClick={() => setIsEditorOpen(false)} type="button">{t.close}</button>
            </header>
            <div className="directory-form-grid">
              {([
                ["display_name", t.fields.displayName, 160, true],
                ["department", t.fields.department, 160, false],
                ["position", t.fields.position, 160, false],
                ["internal_phone", t.fields.internalPhone, 64, false],
                ["work_phone", t.fields.workPhone, 64, false],
                ["mobile_phone", t.fields.mobilePhone, 64, false],
                ["email", t.fields.email, 320, false],
                ["room", t.fields.room, 80, false],
                ["location", t.fields.location, 255, false]
              ] as const).map(([field, label, maxLength, required]) => (
                <label className="field" key={field}>
                  <span className="field-label">{label}</span>
                  <input
                    className="field-input"
                    maxLength={maxLength}
                    onChange={(event) => setForm((current) => ({ ...current, [field]: event.target.value }))}
                    required={required}
                    type={field === "email" ? "email" : "text"}
                    value={form[field]}
                  />
                </label>
              ))}
              <label className="field">
                <span className="field-label">{t.fields.linkedUser}</span>
                <select className="field-input" onChange={(event) => setForm((current) => ({ ...current, linked_user_id: event.target.value }))} value={form.linked_user_id}>
                  <option value="">{t.noLinkedUser}</option>
                  {managerUsers.map((user) => <option key={user.id} value={user.id}>{user.display_name} (@{user.username})</option>)}
                </select>
              </label>
              <label className="field directory-notes-field">
                <span className="field-label">{t.fields.notes}</span>
                <textarea className="field-input" maxLength={2000} onChange={(event) => setForm((current) => ({ ...current, notes: event.target.value }))} rows={4} value={form.notes} />
              </label>
            </div>
            <div className="actions">
              <button className="primary-button" disabled={isSaving} type="submit">{isSaving ? t.saving : t.save}</button>
              <button className="secondary-link" disabled={isSaving} onClick={() => setIsEditorOpen(false)} type="button">{t.cancel}</button>
            </div>
          </form>
        </div>
      ) : null}

      {isImportOpen ? (
        <DirectoryImportWizard
          dictionary={dictionary}
          onClose={() => setIsImportOpen(false)}
          onImported={() => {
            setPage(1);
            void loadEntries();
            void loadDepartments();
          }}
        />
      ) : null}
    </div>
  );
}
