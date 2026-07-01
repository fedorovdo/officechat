"use client";

import { FormEvent, KeyboardEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";

import {
  addDirectMessageReaction,
  deleteDirectMessage,
  editDirectMessage,
  getDirectMessages,
  getDirectWebSocketUrl,
  getStoredAccessToken,
  removeDirectMessageReaction,
  sendDirectMessage,
  type DirectMessageEvent,
  type OfficeChatDirectConversation,
  type OfficeChatDirectMessage,
  type OfficeChatMessageReaction,
  type OfficeChatUser
} from "../lib/api";
import type { Dictionary, Locale } from "../lib/i18n";
import { EmojiPicker } from "./EmojiPicker";
import { MessageReactions, reactionsForCurrentUser } from "./MessageReactions";
import { UserAvatar } from "./UserAvatar";

type DirectChatPanelProps = {
  conversation: OfficeChatDirectConversation;
  currentUser: OfficeChatUser;
  dictionary: Dictionary;
  locale: Locale;
};

type LiveUpdateStatus = "connected" | "disconnected" | "reconnecting";

export function DirectChatPanel({ conversation, currentUser, dictionary, locale }: DirectChatPanelProps) {
  const router = useRouter();
  const composeFormRef = useRef<HTMLFormElement | null>(null);
  const composerTextareaRef = useRef<HTMLTextAreaElement | null>(null);
  const messagesListRef = useRef<HTMLDivElement | null>(null);
  const messagesEndRef = useRef<HTMLDivElement | null>(null);
  const shouldScrollToBottomRef = useRef(false);
  const hasInitialMessageScrollRef = useRef(false);
  const [messages, setMessages] = useState<OfficeChatDirectMessage[]>([]);
  const [messageBody, setMessageBody] = useState("");
  const [emojiPickerResetKey, setEmojiPickerResetKey] = useState(0);
  const [replyToMessage, setReplyToMessage] = useState<OfficeChatDirectMessage | null>(null);
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

  function isNearMessagesBottom() {
    const messagesList = messagesListRef.current;
    if (!messagesList) {
      return true;
    }
    return messagesList.scrollHeight - messagesList.scrollTop - messagesList.clientHeight < 180;
  }

  function scrollToLatestMessage(behavior: ScrollBehavior = "smooth") {
    const messagesList = messagesListRef.current;
    if (messagesList) {
      messagesList.scrollTo({ top: messagesList.scrollHeight, behavior });
    } else {
      messagesEndRef.current?.scrollIntoView({ behavior, block: "end" });
    }
    setShowNewMessagesButton(false);
  }

  function resizeComposer(textarea: HTMLTextAreaElement) {
    textarea.style.height = "0px";
    const nextHeight = Math.min(textarea.scrollHeight, 160);
    textarea.style.height = `${nextHeight}px`;
    textarea.style.overflowY = textarea.scrollHeight > 160 ? "auto" : "hidden";
  }

  const refreshMessages = useCallback(
    async (token: string) => {
      setMessages(await getDirectMessages(token, conversation.id));
    },
    [conversation.id]
  );

  useEffect(() => {
    hasInitialMessageScrollRef.current = false;
    shouldScrollToBottomRef.current = false;
    setShowNewMessagesButton(false);
    setEditingMessageId(null);
    setEditingMessageBody("");
    setMessageBody("");
    setReplyToMessage(null);
  }, [conversation.id]);

  useEffect(() => {
    const token = getStoredAccessToken();
    if (!token) {
      router.replace(`/${locale}/login`);
      return;
    }
    void refreshMessages(token).catch(() => setError(dictionary.directMessages.loadError));
  }, [dictionary.directMessages.loadError, conversation.id, locale, refreshMessages, router]);

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
      if (isNearMessagesBottom()) {
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
      websocket = new WebSocket(getDirectWebSocketUrl(accessToken, conversation.id));
      websocket.onopen = () => {
        reconnectAttempts = 0;
        setLiveUpdateStatus("connected");
      };
      websocket.onmessage = (event) => {
        try {
          const payload = JSON.parse(event.data as string) as DirectMessageEvent;
          if (payload.type === "direct.message.reactions.updated") {
            const reactions = reactionsForCurrentUser(payload.reactions, currentUser.id);
            setMessages((current) =>
              current.map((message) => (message.id === payload.message_id ? { ...message, reactions } : message))
            );
          } else if (payload.type.startsWith("direct.message.")) {
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
  }, [conversation.id, currentUser.id, locale, refreshMessages, router]);

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
      await addDirectMessageReaction(token, conversation.id, messageId, emoji)
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
      await removeDirectMessageReaction(token, conversation.id, messageId, emoji)
    );
  }

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
      setError(caughtError instanceof Error ? caughtError.message : dictionary.directMessages.loadError);
    }
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
    const abortController = new AbortController();
    const timeout = setTimeout(() => abortController.abort(), 20000);
    try {
      await sendDirectMessage(token, conversation.id, messageBody, abortController.signal, replyToMessage?.id);
      setMessageBody("");
      setEmojiPickerResetKey((current) => current + 1);
      setReplyToMessage(null);
      if (composerTextareaRef.current) {
        composerTextareaRef.current.style.height = "44px";
      }
      shouldScrollToBottomRef.current = true;
      setMessages(await getDirectMessages(token, conversation.id));
      setSuccess(dictionary.directMessages.sendSuccess);
    } catch (caughtError) {
      setError(
        caughtError instanceof Error && caughtError.name !== "AbortError"
          ? caughtError.message
          : dictionary.directMessages.sendError
      );
    } finally {
      clearTimeout(timeout);
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
      await editDirectMessage(token, conversation.id, editingMessageId, editingMessageBody);
      setEditingMessageId(null);
      setEditingMessageBody("");
      setMessages(await getDirectMessages(token, conversation.id));
      setSuccess(dictionary.directMessages.editSuccess);
    } catch (caughtError) {
      setError(caughtError instanceof Error ? caughtError.message : dictionary.directMessages.editError);
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
      await deleteDirectMessage(token, conversation.id, messageId);
      setMessages(await getDirectMessages(token, conversation.id));
      setSuccess(dictionary.directMessages.deleteSuccess);
    } catch (caughtError) {
      setError(caughtError instanceof Error ? caughtError.message : dictionary.directMessages.deleteError);
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

  function getReplyPreviewText(reply: NonNullable<OfficeChatDirectMessage["reply_to"]>) {
    if (reply.is_deleted) {
      return dictionary.messages.originalMessageDeleted;
    }
    return reply.body_preview || dictionary.messages.replyPreviewUnavailable;
  }

  function getSelectedReplyPreviewText(message: OfficeChatDirectMessage) {
    if (message.is_deleted) {
      return dictionary.messages.originalMessageDeleted;
    }
    const body = message.body.trim();
    return body ? (body.length > 120 ? `${body.slice(0, 117)}...` : body) : dictionary.messages.replyPreviewUnavailable;
  }

  return (
    <section className="messages-panel" aria-label={dictionary.directMessages.ariaLabel}>
      <div className="dashboard-header messages-toolbar">
        <div>
          <h2 className="section-title">{dictionary.directMessages.title}</h2>
          <p className={`live-status live-status-${liveUpdateStatus}`}>
            {dictionary.messages.liveStatusLabel} {dictionary.messages.liveStatuses[liveUpdateStatus]}
          </p>
        </div>
        <button className="secondary-link" onClick={() => void handleRefreshMessages()} type="button">
          {dictionary.messages.refresh}
        </button>
      </div>

      <p className="note direct-chat-note">{dictionary.directMessages.attachmentsLater}</p>
      {success ? <p className="form-success">{success}</p> : null}
      {error ? <p className="form-error">{error}</p> : null}

      <div className="messages-list" ref={messagesListRef}>
        {messages.map((message) => {
          const canEdit = currentUser.id === message.sender_user_id && !message.is_deleted;
          const isOwnMessage = currentUser.id === message.sender_user_id;
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
                <UserAvatar className="message-sender-avatar" size={28} user={message.sender} />
                <span className="message-author">
                  <strong>{message.sender.display_name}</strong>
                  <span className="role-badge">{message.sender.role}</span>
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
              <MessageReactions
                canAddReaction={!message.is_deleted}
                dictionary={dictionary}
                onAdd={(emoji) => handleAddReaction(message.id, emoji)}
                onRemove={(emoji) => handleRemoveReaction(message.id, emoji)}
                reactions={message.reactions}
              />
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
                  {canEdit ? (
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

      <form className="message-compose" onSubmit={handleSendMessage} ref={composeFormRef}>
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
        <div className="messenger-composer-row messenger-composer-row-direct">
          <EmojiPicker
            contextKey={conversation.id}
            dictionary={dictionary}
            disabled={isSending}
            onAfterInsert={resizeComposer}
            onChange={setMessageBody}
            resetKey={emojiPickerResetKey}
            textareaRef={composerTextareaRef}
            value={messageBody}
          />
          <textarea
            aria-label={dictionary.messages.body}
            className="field-input composer-textarea"
            onChange={(event) => {
              setMessageBody(event.target.value);
              resizeComposer(event.currentTarget);
            }}
            onKeyDown={handleComposerKeyDown}
            placeholder={dictionary.messages.body}
            ref={composerTextareaRef}
            required
            rows={1}
            value={messageBody}
          />
          <button className="composer-send-button" disabled={isSending || !messageBody.trim()} type="submit">
            {isSending ? dictionary.messages.sending : dictionary.messages.send}
          </button>
        </div>
        <p className="message-compose-hint">{dictionary.appShell.composerShortcut}</p>
      </form>
    </section>
  );
}
