"use client";

import { useEffect, useMemo, useState } from "react";

import {
  createBroadcast,
  ApiResponseError,
  BackendUnavailableError,
  dismissAnnouncement,
  getAnnouncement,
  getAnnouncementUnread,
  getAnnouncements,
  getSentBroadcasts,
  hasPermission,
  previewBroadcastRecipients,
  requireStoredAccessToken,
  retractBroadcast,
  sendBroadcast,
  type BroadcastAnnouncement,
  type BroadcastAudienceType,
  type BroadcastPreview,
  type OfficeChatAnnouncement,
  type OfficeChatDirectoryUser,
  type OfficeChatGroup,
  type OfficeChatUser
} from "../lib/api";
import type { Dictionary, Locale } from "../lib/i18n";
import { createClientId } from "../lib/client-id";

type AnnouncementsPanelProps = {
  currentUser: OfficeChatUser;
  dictionary: Dictionary;
  groups: OfficeChatGroup[];
  locale: Locale;
  reloadKey: number;
  users: OfficeChatDirectoryUser[];
  onUnreadChange: (count: number) => void;
};

const priorities = ["normal", "important", "urgent"] as const;
const audienceTypes = ["all_active_users", "selected_groups", "selected_users"] as const;

function formatDate(value: string | null, locale: Locale) {
  if (!value) return "-";
  return new Intl.DateTimeFormat(locale, { dateStyle: "short", timeStyle: "short" }).format(new Date(value));
}

function makeIdempotencyKey() {
  return createClientId();
}

function getRequiredToken(locale: Locale) {
  const token = requireStoredAccessToken(locale);
  if (!token) throw new Error("Sign-in required");
  return token;
}

export function AnnouncementsPanel({
  currentUser,
  dictionary,
  groups,
  locale,
  reloadKey,
  users,
  onUnreadChange
}: AnnouncementsPanelProps) {
  const t = dictionary.announcements;
  const canBroadcast = hasPermission(currentUser, "can_broadcast");
  const [items, setItems] = useState<OfficeChatAnnouncement[]>([]);
  const [sentItems, setSentItems] = useState<BroadcastAnnouncement[]>([]);
  const [selectedAnnouncement, setSelectedAnnouncement] = useState<OfficeChatAnnouncement | null>(null);
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [priority, setPriority] = useState<(typeof priorities)[number]>("normal");
  const [audienceType, setAudienceType] = useState<BroadcastAudienceType>("selected_groups");
  const [selectedGroupIds, setSelectedGroupIds] = useState<string[]>([]);
  const [selectedUserIds, setSelectedUserIds] = useState<string[]>([]);
  const [preview, setPreview] = useState<BroadcastPreview | null>(null);
  const [confirmationText, setConfirmationText] = useState("");
  const [idempotencyKey, setIdempotencyKey] = useState(makeIdempotencyKey);
  const [currentDraftId, setCurrentDraftId] = useState<string | null>(null);
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");
  const [isBusy, setIsBusy] = useState(false);

  const activeHumanUsers = useMemo(
    () => users.filter((user) => user.is_active && user.role !== "bot"),
    [users]
  );

  async function loadAnnouncements() {
    const token = getRequiredToken(locale);
    const [page, unread] = await Promise.all([
      getAnnouncements(token),
      getAnnouncementUnread(token).catch(() => ({ unread_count: 0 }))
    ]);
    setItems(page.items);
    onUnreadChange(unread.unread_count);
  }

  async function loadSent() {
    if (!canBroadcast) return;
    const token = getRequiredToken(locale);
    const page = await getSentBroadcasts(token);
    setSentItems(page.items);
  }

  useEffect(() => {
    void loadAnnouncements().catch(() => setError(t.loadError));
    void loadSent().catch(() => undefined);
  }, [reloadKey, canBroadcast]);

  const audiencePayload = {
    audience_type: audienceType,
    group_ids: audienceType === "selected_groups" ? selectedGroupIds : [],
    user_ids: audienceType === "selected_users" ? selectedUserIds : []
  };

  function resetPreview() {
    setPreview(null);
    setConfirmationText("");
    setIdempotencyKey(makeIdempotencyKey());
    setCurrentDraftId(null);
  }

  function isAmbiguousSendError(caughtError: unknown) {
    return (
      caughtError instanceof BackendUnavailableError ||
      (caughtError instanceof ApiResponseError && caughtError.status >= 500)
    );
  }

  async function openAnnouncement(announcementId: string) {
    setError("");
    try {
      const token = getRequiredToken(locale);
      const announcement = await getAnnouncement(token, announcementId);
      setSelectedAnnouncement(announcement);
      setItems((current) => current.map((item) => item.id === announcement.id ? announcement : item));
      onUnreadChange(Math.max(0, items.filter((item) => !item.is_read && item.id !== announcement.id).length));
    } catch {
      setError(t.loadError);
    }
  }

  async function dismissSelected() {
    if (!selectedAnnouncement) return;
    setError("");
    try {
      const token = getRequiredToken(locale);
      await dismissAnnouncement(token, selectedAnnouncement.id);
      setItems((current) => current.filter((item) => item.id !== selectedAnnouncement.id));
      setSelectedAnnouncement(null);
      onUnreadChange(Math.max(0, items.filter((item) => !item.is_read && item.id !== selectedAnnouncement.id).length));
    } catch {
      setError(t.dismissError);
    }
  }

  async function previewAudience() {
    setError("");
    setStatus("");
    setIsBusy(true);
    try {
      const token = getRequiredToken(locale);
      const nextPreview = await previewBroadcastRecipients(token, audiencePayload);
      setPreview(nextPreview);
      setStatus(t.previewSuccess.replace("{count}", String(nextPreview.recipient_count)));
    } catch {
      setPreview(null);
      setError(t.previewError);
    } finally {
      setIsBusy(false);
    }
  }

  async function sendCurrentBroadcast() {
    if (!preview) return;
    if (priority === "urgent" && audienceType === "all_active_users" && confirmationText !== t.confirmWord) {
      setError(t.confirmRequired.replace("{word}", t.confirmWord));
      return;
    }
    setError("");
    setStatus("");
    setIsBusy(true);
    try {
      const token = getRequiredToken(locale);
      let draftId = currentDraftId;
      if (!draftId) {
        try {
          const draft = await createBroadcast(token, { title, body, priority, ...audiencePayload });
          draftId = draft.id;
          setCurrentDraftId(draft.id);
        } catch {
          setError(t.draftSaveError);
          return;
        }
      }
      await sendBroadcast(token, draftId, {
        confirmation_token: preview.confirmation_token,
        expected_recipient_count: preview.recipient_count,
        idempotency_key: idempotencyKey
      });
      setTitle("");
      setBody("");
      setPriority("normal");
      setSelectedGroupIds([]);
      setSelectedUserIds([]);
      resetPreview();
      setStatus(t.sendSuccess);
      await loadSent();
    } catch (caughtError) {
      if (isAmbiguousSendError(caughtError)) {
        setError(t.mayAlreadySent);
        await loadSent().catch(() => undefined);
      } else {
        setError(t.sendError);
      }
    } finally {
      setIsBusy(false);
    }
  }

  async function retractSentBroadcast(broadcastId: string) {
    setError("");
    try {
      const token = getRequiredToken(locale);
      await retractBroadcast(token, broadcastId);
      setStatus(t.retractSuccess);
      await loadSent();
    } catch {
      setError(t.retractError);
    }
  }

  function toggleValue(current: string[], value: string) {
    resetPreview();
    return current.includes(value) ? current.filter((item) => item !== value) : [...current, value];
  }

  return (
    <div className="announcements-panel">
      <div className="user-app-chat-heading">
        <div>
          <p className="eyebrow">{t.eyebrow}</p>
          <h2 className="section-title">{t.title}</h2>
        </div>
      </div>
      {error ? <p className="form-error">{error}</p> : null}
      {status ? <p className="form-success">{status}</p> : null}

      <div className="announcements-grid">
        <section className="announcements-card" aria-label={t.inbox}>
          <h3>{t.inbox}</h3>
          <div className="announcement-list">
            {items.length === 0 ? <p className="muted">{t.emptyInbox}</p> : null}
            {items.map((announcement) => (
              <button
                className={announcement.is_read ? "announcement-list-item" : "announcement-list-item announcement-unread"}
                key={announcement.id}
                onClick={() => void openAnnouncement(announcement.id)}
                type="button"
              >
                <span>
                  <strong>{announcement.title}</strong>
                  <small>{announcement.sender} · {formatDate(announcement.sent_at, locale)}</small>
                </span>
                <span className={`priority-badge priority-${announcement.priority}`}>{t.priorities[announcement.priority]}</span>
              </button>
            ))}
          </div>
          {selectedAnnouncement ? (
            <article className="announcement-detail">
              <div className="dashboard-header">
                <div>
                  <p className="eyebrow">{t.from.replace("{name}", selectedAnnouncement.sender)}</p>
                  <h3>{selectedAnnouncement.title}</h3>
                </div>
                <button className="table-action" onClick={() => setSelectedAnnouncement(null)} type="button">
                  {dictionary.appShell.close}
                </button>
              </div>
              <pre>{selectedAnnouncement.body ?? t.retracted}</pre>
              <div className="actions">
                <button className="secondary-link" onClick={() => void dismissSelected()} type="button">
                  {t.dismiss}
                </button>
              </div>
            </article>
          ) : null}
        </section>

        {canBroadcast ? (
          <section className="announcements-card announcements-compose" aria-label={t.compose}>
            <h3>{t.compose}</h3>
            <label className="field">
              <span className="field-label">{t.fields.title}</span>
              <input className="field-input" maxLength={160} onChange={(event) => { resetPreview(); setTitle(event.target.value); }} value={title} />
            </label>
            <label className="field">
              <span className="field-label">{t.fields.body}</span>
              <textarea className="field-input" rows={6} onChange={(event) => { resetPreview(); setBody(event.target.value); }} value={body} />
            </label>
            <div className="form-grid">
              <label className="field">
                <span className="field-label">{t.fields.priority}</span>
                <select className="field-input" onChange={(event) => { resetPreview(); setPriority(event.target.value as typeof priority); }} value={priority}>
                  {priorities.map((item) => <option key={item} value={item}>{t.priorities[item]}</option>)}
                </select>
              </label>
              <label className="field">
                <span className="field-label">{t.fields.audience}</span>
                <select className="field-input" onChange={(event) => { resetPreview(); setAudienceType(event.target.value as BroadcastAudienceType); }} value={audienceType}>
                  {audienceTypes.map((item) => <option key={item} value={item}>{t.audienceTypes[item]}</option>)}
                </select>
              </label>
            </div>

            {audienceType === "selected_groups" ? (
              <div className="announcement-picks">
                {groups.filter((group) => group.is_active).map((group) => (
                  <label key={group.id}>
                    <input
                      checked={selectedGroupIds.includes(group.id)}
                      onChange={() => setSelectedGroupIds((current) => toggleValue(current, group.id))}
                      type="checkbox"
                    /> {group.name}
                  </label>
                ))}
              </div>
            ) : null}
            {audienceType === "selected_users" ? (
              <div className="announcement-picks">
                {activeHumanUsers.map((user) => (
                  <label key={user.id}>
                    <input
                      checked={selectedUserIds.includes(user.id)}
                      onChange={() => setSelectedUserIds((current) => toggleValue(current, user.id))}
                      type="checkbox"
                    /> {user.display_name} (@{user.username})
                  </label>
                ))}
              </div>
            ) : null}

            <div className="actions">
              <button className="secondary-link" disabled={isBusy || !title.trim() || !body.trim()} onClick={() => void previewAudience()} type="button">
                {t.preview}
              </button>
              <button className="primary-button" disabled={isBusy || !preview} onClick={() => void sendCurrentBroadcast()} type="button">
                {isBusy ? t.sending : t.send}
              </button>
            </div>
            {preview ? (
              <div className="announcement-preview">
                <strong>{t.recipients.replace("{count}", String(preview.recipient_count))}</strong>
                <small>{t.previewExpires.replace("{time}", formatDate(preview.expires_at, locale))}</small>
                {priority === "urgent" && audienceType === "all_active_users" ? (
                  <label className="field">
                    <span className="field-label">{t.confirmUrgent.replace("{word}", t.confirmWord)}</span>
                    <input className="field-input" onChange={(event) => setConfirmationText(event.target.value)} value={confirmationText} />
                  </label>
                ) : null}
              </div>
            ) : null}
          </section>
        ) : null}

        {canBroadcast ? (
          <section className="announcements-card announcements-history" aria-label={t.history}>
            <h3>{t.history}</h3>
            {sentItems.length === 0 ? <p className="muted">{t.emptyHistory}</p> : null}
            {sentItems.map((item) => (
              <div className="announcement-history-item" key={item.id}>
                <div>
                  <strong>{item.title}</strong>
                  <small>{t.recipients.replace("{count}", String(item.recipient_count))} · {t.readStats.replace("{read}", String(item.read_count)).replace("{total}", String(item.recipient_count))}</small>
                </div>
                <span className={`priority-badge priority-${item.priority}`}>{t.statuses[item.status]}</span>
                {item.status === "sent" || item.status === "partially_failed" ? (
                  <button className="table-action" onClick={() => void retractSentBroadcast(item.id)} type="button">
                    {t.retract}
                  </button>
                ) : null}
              </div>
            ))}
          </section>
        ) : null}
      </div>
    </div>
  );
}
