"use client";

import { FormEvent, KeyboardEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";

import {
  deleteGroupMessage,
  downloadAttachment,
  editGroupMessage,
  getGroupMessages,
  getGroupWebSocketUrl,
  getStoredAccessToken,
  sendGroupMessage,
  sendGroupMessageWithAttachment,
  type GroupMessageEvent,
  type OfficeChatMessage,
  type OfficeChatUser
} from "../lib/api";
import type { Dictionary, Locale } from "../lib/i18n";

type GroupChatPanelProps = {
  canModerateMessages: boolean;
  currentUser: OfficeChatUser;
  dictionary: Dictionary;
  groupId: string;
  locale: Locale;
};

type LiveUpdateStatus = "connected" | "disconnected" | "reconnecting";

export function GroupChatPanel({
  canModerateMessages,
  currentUser,
  dictionary,
  groupId,
  locale
}: GroupChatPanelProps) {
  const router = useRouter();
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const composeFormRef = useRef<HTMLFormElement | null>(null);
  const messagesEndRef = useRef<HTMLDivElement | null>(null);
  const shouldScrollToBottomRef = useRef(false);
  const hasInitialMessageScrollRef = useRef(false);
  const [messages, setMessages] = useState<OfficeChatMessage[]>([]);
  const [messageBody, setMessageBody] = useState("");
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [replyToMessage, setReplyToMessage] = useState<OfficeChatMessage | null>(null);
  const [editingMessageId, setEditingMessageId] = useState<string | null>(null);
  const [editingMessageBody, setEditingMessageBody] = useState("");
  const [isSending, setIsSending] = useState(false);
  const [liveUpdateStatus, setLiveUpdateStatus] = useState<LiveUpdateStatus>("disconnected");
  const [showNewMessagesButton, setShowNewMessagesButton] = useState(false);
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

  function formatFileSize(sizeBytes: number) {
    if (sizeBytes < 1024) {
      return `${sizeBytes} B`;
    }
    if (sizeBytes < 1024 * 1024) {
      return `${(sizeBytes / 1024).toFixed(1)} KB`;
    }
    return `${(sizeBytes / (1024 * 1024)).toFixed(1)} MB`;
  }

  function isNearPageBottom() {
    if (typeof window === "undefined") {
      return true;
    }
    const scrollBottom = window.scrollY + window.innerHeight;
    return document.documentElement.scrollHeight - scrollBottom < 240;
  }

  function scrollToLatestMessage(behavior: ScrollBehavior = "smooth") {
    messagesEndRef.current?.scrollIntoView({ behavior, block: "end" });
    setShowNewMessagesButton(false);
  }

  const refreshMessages = useCallback(
    async (token: string) => {
      setMessages(await getGroupMessages(token, groupId));
    },
    [groupId]
  );

  useEffect(() => {
    hasInitialMessageScrollRef.current = false;
    shouldScrollToBottomRef.current = false;
    setShowNewMessagesButton(false);
    setReplyToMessage(null);
  }, [groupId]);

  useEffect(() => {
    const token = getStoredAccessToken();
    if (!token) {
      router.replace(`/${locale}/login`);
      return;
    }
    void refreshMessages(token).catch(() => setError(dictionary.messages.loadError));
  }, [dictionary.messages.loadError, groupId, locale, refreshMessages, router]);

  useEffect(() => {
    if (messages.length === 0) {
      return;
    }

    if (!hasInitialMessageScrollRef.current) {
      hasInitialMessageScrollRef.current = true;
      requestAnimationFrame(() => scrollToLatestMessage("auto"));
      return;
    }

    if (shouldScrollToBottomRef.current) {
      shouldScrollToBottomRef.current = false;
      requestAnimationFrame(() => scrollToLatestMessage());
    }
  }, [messages]);

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

    function markIncomingMessage() {
      if (isNearPageBottom()) {
        shouldScrollToBottomRef.current = true;
      } else {
        setShowNewMessagesButton(true);
      }
    }

    function scheduleReconnect() {
      if (!shouldReconnect) {
        return;
      }
      if (reconnectAttempts >= maxReconnectAttempts) {
        setLiveUpdateStatus("disconnected");
        return;
      }

      reconnectAttempts += 1;
      setLiveUpdateStatus("reconnecting");
      reconnectTimer = setTimeout(connect, 3000);
    }

    function connect() {
      websocket = new WebSocket(getGroupWebSocketUrl(accessToken, groupId));
      websocket.onopen = () => {
        reconnectAttempts = 0;
        setLiveUpdateStatus("connected");
      };
      websocket.onmessage = (event) => {
        try {
          const payload = JSON.parse(event.data as string) as GroupMessageEvent;
          if (payload.type.startsWith("message.")) {
            markIncomingMessage();
            void refreshMessages(accessToken);
          }
        } catch {
          markIncomingMessage();
          void refreshMessages(accessToken);
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
      websocket.onerror = () => {
        websocket?.close();
      };
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
  }, [groupId, locale, refreshMessages, router]);

  async function handleRefreshMessages() {
    const token = getStoredAccessToken();
    if (!token) {
      router.replace(`/${locale}/login`);
      return;
    }

    setError("");
    try {
      shouldScrollToBottomRef.current = true;
      await refreshMessages(token);
    } catch (caughtError) {
      setError(caughtError instanceof Error ? caughtError.message : dictionary.messages.loadError);
    }
  }

  function getReplyPreviewText(reply: NonNullable<OfficeChatMessage["reply_to"]>) {
    if (reply.is_deleted) {
      return dictionary.messages.originalMessageDeleted;
    }
    return reply.body_preview || dictionary.messages.replyPreviewUnavailable;
  }

  function getSelectedReplyPreviewText(message: OfficeChatMessage) {
    if (message.is_deleted) {
      return dictionary.messages.originalMessageDeleted;
    }
    const body = message.body.trim();
    if (body) {
      return body.length > 120 ? `${body.slice(0, 117)}...` : body;
    }
    if (message.attachments.length > 0) {
      return dictionary.sidebarActivity.attachment;
    }
    return dictionary.messages.replyPreviewUnavailable;
  }

  async function handleSendMessage(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const token = getStoredAccessToken();
    if (!token) {
      router.replace(`/${locale}/login`);
      return;
    }

    setError("");
    setSuccess("");
    setIsSending(true);
    try {
      if (selectedFile) {
        await sendGroupMessageWithAttachment(token, groupId, messageBody, selectedFile, replyToMessage?.id);
      } else {
        await sendGroupMessage(token, groupId, messageBody, replyToMessage?.id);
      }
      setMessageBody("");
      setSelectedFile(null);
      setReplyToMessage(null);
      if (fileInputRef.current) {
        fileInputRef.current.value = "";
      }
      shouldScrollToBottomRef.current = true;
      setMessages(await getGroupMessages(token, groupId));
      setSuccess(dictionary.messages.sendSuccess);
    } catch (caughtError) {
      setError(caughtError instanceof Error ? caughtError.message : dictionary.messages.sendError);
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
      await editGroupMessage(token, groupId, editingMessageId, editingMessageBody);
      setEditingMessageId(null);
      setEditingMessageBody("");
      setMessages(await getGroupMessages(token, groupId));
      setSuccess(dictionary.messages.editSuccess);
    } catch (caughtError) {
      setError(caughtError instanceof Error ? caughtError.message : dictionary.messages.editError);
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
      await deleteGroupMessage(token, groupId, messageId);
      setMessages(await getGroupMessages(token, groupId));
      setSuccess(dictionary.messages.deleteSuccess);
    } catch (caughtError) {
      setError(caughtError instanceof Error ? caughtError.message : dictionary.messages.deleteError);
    }
  }

  async function handleDownloadAttachment(downloadUrl: string, filename: string) {
    const token = getStoredAccessToken();
    if (!token) {
      router.replace(`/${locale}/login`);
      return;
    }

    setError("");
    try {
      const blob = await downloadAttachment(token, downloadUrl);
      const objectUrl = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = objectUrl;
      anchor.download = filename;
      document.body.append(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(objectUrl);
    } catch (caughtError) {
      setError(caughtError instanceof Error ? caughtError.message : dictionary.messages.downloadError);
    }
  }

  function handleComposerKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && event.ctrlKey && !isSending) {
      event.preventDefault();
      composeFormRef.current?.requestSubmit();
    }
  }

  return (
    <section className="messages-panel" aria-label={dictionary.messages.ariaLabel}>
      <div className="dashboard-header">
        <div>
          <h2 className="section-title">{dictionary.messages.title}</h2>
          <p className={`live-status live-status-${liveUpdateStatus}`}>
            {dictionary.messages.liveStatusLabel} {dictionary.messages.liveStatuses[liveUpdateStatus]}
          </p>
        </div>
        <button className="secondary-link" onClick={() => void handleRefreshMessages()} type="button">
          {dictionary.messages.refresh}
        </button>
      </div>

      {success ? <p className="form-success">{success}</p> : null}
      {error ? <p className="form-error">{error}</p> : null}

      <div className="messages-list">
        {messages.map((message) => {
          const canEdit = currentUser.id === message.sender_user_id && !message.is_deleted;
          const canDelete = (canEdit || canModerateMessages) && !message.is_deleted;
          const isOwnMessage = currentUser.id === message.sender_user_id;
          const isBotMessage = message.sender.role === "bot";
          const messageItemClasses = [
            "message-item",
            isOwnMessage ? "message-item-own" : "",
            message.is_deleted ? "message-item-deleted" : ""
          ]
            .filter(Boolean)
            .join(" ");
          return (
            <article className={messageItemClasses} key={message.id}>
              <div className="message-meta">
                <span className="message-author">
                  <strong>{message.sender.display_name}</strong>
                  {isBotMessage ? (
                    <span className="bot-badge">{dictionary.messages.botBadge}</span>
                  ) : (
                    <span className="role-badge">{message.sender.role}</span>
                  )}
                </span>
                <span className="message-username">@{message.sender.username}</span>
                <span className="message-time">{dateFormatter.format(new Date(message.created_at))}</span>
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
                    <button className="primary-button" type="submit">
                      {dictionary.messages.saveEdit}
                    </button>
                    <button
                      className="secondary-link"
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
                <>
                  {message.reply_to ? (
                    <div className="message-reply-preview">
                      <span>
                        {dictionary.messages.replyTo} {message.reply_to.sender.display_name}
                      </span>
                      <p>{getReplyPreviewText(message.reply_to)}</p>
                    </div>
                  ) : null}
                  <p className={message.is_deleted ? "message-body deleted-message" : "message-body"}>
                    {message.is_deleted ? dictionary.messages.deletedMessage : message.body}
                  </p>
                </>
              )}
              {message.attachments.length > 0 ? (
                <div className="attachments-list">
                  {message.attachments.map((attachment) => (
                    <button
                      className="attachment-button"
                      key={attachment.id}
                      onClick={() =>
                        void handleDownloadAttachment(attachment.download_url, attachment.original_filename)
                      }
                      type="button"
                    >
                      <span>{attachment.original_filename}</span>
                      <span>{formatFileSize(attachment.size_bytes)}</span>
                    </button>
                  ))}
                </div>
              ) : null}
              {!message.is_deleted ? (
                <div className="message-actions">
                  <button className="table-action" onClick={() => setReplyToMessage(message)} type="button">
                    {dictionary.messages.reply}
                  </button>
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
                    <button
                      className="table-action"
                      onClick={() => void handleDeleteMessage(message.id)}
                      type="button"
                    >
                      {dictionary.messages.delete}
                    </button>
                  ) : null}
                </div>
              ) : null}
            </article>
          );
        })}
        <div ref={messagesEndRef} />
      </div>

      {showNewMessagesButton ? (
        <button className="new-messages-button" onClick={() => scrollToLatestMessage()} type="button">
          {dictionary.messages.newMessages}
        </button>
      ) : null}

      <form className="admin-form message-compose" onSubmit={handleSendMessage} ref={composeFormRef}>
        {replyToMessage ? (
          <div className="reply-compose-context">
            <div>
              <strong>
                {dictionary.messages.replyTo} {replyToMessage.sender.display_name}
              </strong>
              <p>{getSelectedReplyPreviewText(replyToMessage)}</p>
            </div>
            <button className="table-action" onClick={() => setReplyToMessage(null)} type="button">
              {dictionary.messages.cancelReply}
            </button>
          </div>
        ) : null}
        <label className="field">
          <span className="field-label">{dictionary.messages.body}</span>
          <textarea
            className="field-input textarea-input"
            onChange={(event) => setMessageBody(event.target.value)}
            onKeyDown={handleComposerKeyDown}
            required={!selectedFile}
            value={messageBody}
          />
        </label>
        <label className="field">
          <span className="field-label">{dictionary.messages.attachment}</span>
          <input
            className="field-input file-input"
            onChange={(event) => setSelectedFile(event.target.files?.[0] ?? null)}
            ref={fileInputRef}
            type="file"
          />
        </label>
        <button className="primary-button" disabled={isSending} type="submit">
          {isSending
            ? dictionary.messages.sending
            : selectedFile
              ? dictionary.messages.sendWithAttachment
              : dictionary.messages.send}
        </button>
      </form>
    </section>
  );
}
