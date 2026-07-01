"use client";

import { FormEvent, KeyboardEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";

import {
  addDiscussionMessageReaction,
  addDiscussionMember,
  deleteDiscussionMessage,
  editDiscussionMessage,
  getDiscussion,
  getDiscussionMessages,
  getDiscussionWebSocketUrl,
  getStoredAccessToken,
  isAdminRole,
  removeDiscussionMember,
  removeDiscussionMessageReaction,
  sendDiscussionMessage,
  type DiscussionEvent,
  type OfficeChatDiscussion,
  type OfficeChatDiscussionMessage,
  type OfficeChatMessageReaction,
  type OfficeChatUser
} from "../lib/api";
import type { Dictionary, Locale } from "../lib/i18n";
import { EmojiPicker } from "./EmojiPicker";
import { MessageReactions, reactionsForCurrentUser } from "./MessageReactions";
import { UserAvatar } from "./UserAvatar";

type DiscussionPanelProps = {
  currentUser: OfficeChatUser;
  dictionary: Dictionary;
  discussionId: string;
  locale: Locale;
  onClose: () => void;
};

type LiveUpdateStatus = "connected" | "disconnected" | "reconnecting";

export function DiscussionPanel({ currentUser, dictionary, discussionId, locale, onClose }: DiscussionPanelProps) {
  const router = useRouter();
  const composeFormRef = useRef<HTMLFormElement | null>(null);
  const composerTextareaRef = useRef<HTMLTextAreaElement | null>(null);
  const [discussion, setDiscussion] = useState<OfficeChatDiscussion | null>(null);
  const [messages, setMessages] = useState<OfficeChatDiscussionMessage[]>([]);
  const [messageBody, setMessageBody] = useState("");
  const [emojiPickerResetKey, setEmojiPickerResetKey] = useState(0);
  const [inviteUsername, setInviteUsername] = useState("");
  const [editingMessageId, setEditingMessageId] = useState<string | null>(null);
  const [editingMessageBody, setEditingMessageBody] = useState("");
  const [isSending, setIsSending] = useState(false);
  const [liveUpdateStatus, setLiveUpdateStatus] = useState<LiveUpdateStatus>("disconnected");
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");

  const dateFormatter = useMemo(
    () =>
      new Intl.DateTimeFormat(locale, {
        dateStyle: "medium",
        timeStyle: "short"
      }),
    [locale]
  );

  function resizeComposer(textarea: HTMLTextAreaElement) {
    textarea.style.height = "0px";
    const nextHeight = Math.min(textarea.scrollHeight, 160);
    textarea.style.height = `${nextHeight}px`;
    textarea.style.overflowY = textarea.scrollHeight > 160 ? "auto" : "hidden";
  }

  const refreshDiscussion = useCallback(async (token: string) => {
    const [loadedDiscussion, loadedMessages] = await Promise.all([
      getDiscussion(token, discussionId),
      getDiscussionMessages(token, discussionId)
    ]);
    setDiscussion(loadedDiscussion);
    setMessages(loadedMessages);
  }, [discussionId]);

  useEffect(() => {
    const token = getStoredAccessToken();
    if (!token) {
      router.replace(`/${locale}/login`);
      return;
    }
    void refreshDiscussion(token).catch((caughtError) => {
      setError(caughtError instanceof Error ? caughtError.message : dictionary.discussions.loadError);
    });
  }, [dictionary.discussions.loadError, discussionId, locale, refreshDiscussion, router]);

  useEffect(() => {
    const token = getStoredAccessToken();
    if (!token) {
      router.replace(`/${locale}/login`);
      return;
    }
    const accessToken = token;
    let websocket: WebSocket | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let shouldReconnect = true;
    let reconnectAttempts = 0;
    const maxReconnectAttempts = 10;

    function scheduleReconnect() {
      if (!shouldReconnect || reconnectAttempts >= maxReconnectAttempts) {
        setLiveUpdateStatus("disconnected");
        return;
      }
      reconnectAttempts += 1;
      setLiveUpdateStatus("reconnecting");
      reconnectTimer = setTimeout(connect, 3000);
    }

    function connect() {
      websocket = new WebSocket(getDiscussionWebSocketUrl(accessToken, discussionId));
      websocket.onopen = () => {
        reconnectAttempts = 0;
        setLiveUpdateStatus("connected");
      };
      websocket.onmessage = (event) => {
        try {
          const payload = JSON.parse(event.data as string) as DiscussionEvent;
          if (payload.type === "discussion.message.reactions.updated") {
            const reactions = reactionsForCurrentUser(payload.reactions, currentUser.id);
            setMessages((current) =>
              current.map((message) => (message.id === payload.message_id ? { ...message, reactions } : message))
            );
          } else if (payload.type.startsWith("discussion.")) {
            void refreshDiscussion(accessToken);
          }
        } catch {
          void refreshDiscussion(accessToken);
        }
      };
      websocket.onclose = (event) => {
        websocket = null;
        if (event.code === 1008) {
          setLiveUpdateStatus("disconnected");
          return;
        }
        scheduleReconnect();
      };
      websocket.onerror = () => websocket?.close();
    }

    setLiveUpdateStatus("reconnecting");
    connect();
    return () => {
      shouldReconnect = false;
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
      }
      websocket?.close();
    };
  }, [currentUser.id, discussionId, locale, refreshDiscussion, router]);

  function applyReactionUpdate(messageId: string, reactions: OfficeChatMessageReaction[]) {
    const normalized = reactionsForCurrentUser(reactions, currentUser.id);
    setMessages((current) =>
      current.map((message) => (message.id === messageId ? { ...message, reactions: normalized } : message))
    );
    return normalized;
  }

  async function handleAddReaction(messageId: string, emoji: string) {
    const token = getStoredAccessToken();
    if (!token) {
      router.replace(`/${locale}/login`);
      throw new Error(dictionary.messages.reactions.updateError);
    }
    return applyReactionUpdate(
      messageId,
      await addDiscussionMessageReaction(token, discussionId, messageId, emoji)
    );
  }

  async function handleRemoveReaction(messageId: string, emoji: string) {
    const token = getStoredAccessToken();
    if (!token) {
      router.replace(`/${locale}/login`);
      throw new Error(dictionary.messages.reactions.updateError);
    }
    return applyReactionUpdate(
      messageId,
      await removeDiscussionMessageReaction(token, discussionId, messageId, emoji)
    );
  }

  async function handleSendMessage(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (isSending || !messageBody.trim()) {
      return;
    }
    const token = getStoredAccessToken();
    if (!token) {
      router.replace(`/${locale}/login`);
      return;
    }
    setError("");
    setSuccess("");
    setIsSending(true);
    try {
      await sendDiscussionMessage(token, discussionId, messageBody);
      setMessageBody("");
      setEmojiPickerResetKey((current) => current + 1);
      if (composerTextareaRef.current) composerTextareaRef.current.style.height = "42px";
      setMessages(await getDiscussionMessages(token, discussionId));
      setSuccess(dictionary.discussions.sendSuccess);
    } catch (caughtError) {
      setError(caughtError instanceof Error ? caughtError.message : dictionary.discussions.sendError);
    } finally {
      setIsSending(false);
    }
  }

  async function handleEditMessage(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const token = getStoredAccessToken();
    if (!token || !editingMessageId) {
      router.replace(`/${locale}/login`);
      return;
    }
    setError("");
    setSuccess("");
    try {
      await editDiscussionMessage(token, discussionId, editingMessageId, editingMessageBody);
      setEditingMessageId(null);
      setEditingMessageBody("");
      setMessages(await getDiscussionMessages(token, discussionId));
      setSuccess(dictionary.discussions.editSuccess);
    } catch (caughtError) {
      setError(caughtError instanceof Error ? caughtError.message : dictionary.discussions.editError);
    }
  }

  async function handleDeleteMessage(messageId: string) {
    const token = getStoredAccessToken();
    if (!token) {
      router.replace(`/${locale}/login`);
      return;
    }
    setError("");
    setSuccess("");
    try {
      await deleteDiscussionMessage(token, discussionId, messageId);
      setMessages(await getDiscussionMessages(token, discussionId));
      setSuccess(dictionary.discussions.deleteSuccess);
    } catch (caughtError) {
      setError(caughtError instanceof Error ? caughtError.message : dictionary.discussions.deleteError);
    }
  }

  async function handleInviteMember(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const token = getStoredAccessToken();
    if (!token) {
      router.replace(`/${locale}/login`);
      return;
    }
    setError("");
    setSuccess("");
    try {
      const normalizedUsername = inviteUsername.trim().replace(/^@/, "").trim();
      await addDiscussionMember(token, discussionId, normalizedUsername);
      setInviteUsername("");
      setDiscussion(await getDiscussion(token, discussionId));
      setSuccess(dictionary.discussions.inviteSuccess);
    } catch (caughtError) {
      const message = caughtError instanceof Error ? caughtError.message : "";
      setError(
        message.includes("not found") || message.includes("source group")
          ? dictionary.discussions.inviteUserNotFound
          : message || dictionary.discussions.inviteError
      );
    }
  }

  async function handleRemoveMember(memberId: string) {
    const token = getStoredAccessToken();
    if (!token) {
      router.replace(`/${locale}/login`);
      return;
    }
    setError("");
    setSuccess("");
    try {
      await removeDiscussionMember(token, discussionId, memberId);
      setDiscussion(await getDiscussion(token, discussionId));
      setSuccess(dictionary.discussions.removeSuccess);
    } catch (caughtError) {
      setError(caughtError instanceof Error ? caughtError.message : dictionary.discussions.removeError);
    }
  }

  function handleComposerKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (
      event.key === "Enter" &&
      !event.shiftKey &&
      !event.nativeEvent.isComposing &&
      !isSending &&
      messageBody.trim()
    ) {
      event.preventDefault();
      composeFormRef.current?.requestSubmit();
    }
  }

  const currentMembership = discussion?.members.find((member) => member.user_id === currentUser.id);
  const canDeleteOthers = currentMembership?.role === "owner" || isAdminRole(currentUser.role);

  return (
    <aside className="discussion-panel" aria-label={dictionary.discussions.ariaLabel}>
      <div className="dashboard-header discussion-panel-header">
        <div>
          <p className="eyebrow">{dictionary.discussions.eyebrow}</p>
          <h2 className="section-title">{discussion?.title || dictionary.discussions.title}</h2>
          <p className={`live-status live-status-${liveUpdateStatus}`}>
            {dictionary.messages.liveStatusLabel} {dictionary.messages.liveStatuses[liveUpdateStatus]}
          </p>
        </div>
        <button className="table-action" onClick={onClose} type="button">
          {dictionary.discussions.close}
        </button>
      </div>

      {error ? <p className="form-error">{error}</p> : null}
      {success ? <p className="form-success">{success}</p> : null}

      {discussion ? (
        <>
          <section className="discussion-source">
            <strong>
              {dictionary.discussions.sourceMessage}: {discussion.source_message.sender.display_name}
            </strong>
            <p>
              {discussion.source_message.is_deleted
                ? dictionary.messages.deletedMessage
                : discussion.source_message.body_preview}
            </p>
          </section>

          <section className="discussion-section">
            <h3 className="compact-title">{dictionary.discussions.members}</h3>
            <div className="discussion-members">
              {discussion.members.map((member) => (
                <div className="discussion-member" key={member.id}>
                  <span className="discussion-member-identity">
                    <UserAvatar size={30} user={member.user} />
                    <span>
                      <strong>{member.user.display_name}</strong> @{member.user.username}
                    </span>
                  </span>
                  <span className="role-badge">{member.role}</span>
                  {discussion.can_manage_members ? (
                    <button className="table-action" onClick={() => void handleRemoveMember(member.id)} type="button">
                      {dictionary.discussions.removeMember}
                    </button>
                  ) : null}
                </div>
              ))}
            </div>
            {discussion.can_manage_members ? (
              <form className="discussion-invite-form" onSubmit={handleInviteMember}>
                <label className="field">
                  <span className="field-label">{dictionary.discussions.addParticipant}</span>
                  <input
                    className="field-input"
                    onChange={(event) => setInviteUsername(event.target.value)}
                    placeholder={dictionary.discussions.usernamePlaceholder}
                    required
                    value={inviteUsername}
                  />
                </label>
                <button className="secondary-link" type="submit">
                  {dictionary.discussions.add}
                </button>
              </form>
            ) : null}
          </section>
        </>
      ) : null}

      <section className="discussion-section discussion-messages-section">
        <h3 className="compact-title">{dictionary.discussions.messages}</h3>
        <div className="discussion-messages-list">
          {messages.map((message) => {
            const canEdit = message.sender_user_id === currentUser.id && !message.is_deleted;
            const canDelete = (message.sender_user_id === currentUser.id || canDeleteOthers) && !message.is_deleted;
            return (
              <article className={message.is_deleted ? "discussion-message discussion-message-deleted" : "discussion-message"} key={message.id}>
                <div className="message-meta">
                  <UserAvatar className="message-sender-avatar" size={28} user={message.sender} />
                  <strong>{message.sender.display_name}</strong>
                  <span>@{message.sender.username}</span>
                  <span>{dateFormatter.format(new Date(message.created_at))}</span>
                  {message.edited_at ? <span>{dictionary.messages.edited}</span> : null}
                </div>
                {editingMessageId === message.id ? (
                  <form className="message-edit-form" onSubmit={handleEditMessage}>
                    <textarea
                      className="field-input textarea-input"
                      onChange={(event) => setEditingMessageBody(event.target.value)}
                      required
                      value={editingMessageBody}
                    />
                    <div className="actions">
                      <button className="primary-button" type="submit">{dictionary.messages.saveEdit}</button>
                      <button
                        className="table-action"
                        onClick={() => {
                          setEditingMessageId(null);
                          setEditingMessageBody("");
                        }}
                        type="button"
                      >
                        {dictionary.messages.cancelEdit}
                      </button>
                    </div>
                  </form>
                ) : (
                  <p className={message.is_deleted ? "message-body deleted-message" : "message-body"}>
                    {message.is_deleted ? dictionary.messages.deletedMessage : message.body}
                  </p>
                )}
                <MessageReactions
                  canAddReaction={!message.is_deleted}
                  dictionary={dictionary}
                  onAdd={(emoji) => handleAddReaction(message.id, emoji)}
                  onRemove={(emoji) => handleRemoveReaction(message.id, emoji)}
                  reactions={message.reactions}
                />
                {!message.is_deleted ? (
                  <div className="message-actions">
                    {canEdit ? (
                      <button
                        className="table-action"
                        onClick={() => {
                          setEditingMessageId(message.id);
                          setEditingMessageBody(message.body);
                        }}
                        type="button"
                      >
                        {dictionary.messages.edit}
                      </button>
                    ) : null}
                    {canDelete ? (
                      <button className="table-action" onClick={() => void handleDeleteMessage(message.id)} type="button">
                        {dictionary.messages.delete}
                      </button>
                    ) : null}
                  </div>
                ) : null}
              </article>
            );
          })}
        </div>
      </section>

      <form className="admin-form discussion-compose" onSubmit={handleSendMessage} ref={composeFormRef}>
        <div className="discussion-composer-row">
          <EmojiPicker
            contextKey={discussionId}
            dictionary={dictionary}
            disabled={isSending}
            onAfterInsert={resizeComposer}
            onChange={setMessageBody}
            resetKey={emojiPickerResetKey}
            textareaRef={composerTextareaRef}
            value={messageBody}
          />
          <textarea
            aria-label={dictionary.discussions.message}
            className="field-input composer-textarea"
            onChange={(event) => {
              setMessageBody(event.target.value);
              resizeComposer(event.currentTarget);
            }}
            onKeyDown={handleComposerKeyDown}
            placeholder={dictionary.discussions.message}
            ref={composerTextareaRef}
            required
            rows={1}
            value={messageBody}
          />
          <button className="composer-send-button" disabled={isSending || !messageBody.trim()} type="submit">
            {isSending ? dictionary.messages.sending : dictionary.messages.send}
          </button>
        </div>
      </form>
    </aside>
  );
}
