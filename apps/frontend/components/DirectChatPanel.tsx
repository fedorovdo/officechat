"use client";

import { Fragment, FormEvent, KeyboardEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";

import {
  addDirectMessageReaction,
  deleteDirectMessage,
  downloadDirectAttachment,
  editDirectMessage,
  getArchivedDirectMessages,
  getDirectReadReceipt,
  getDirectMessages,
  getDirectWebSocketUrl,
  getStoredAccessToken,
  removeDirectMessageReaction,
  sendDirectMessage,
  sendDirectMessageWithAttachments,
  type DirectMessageEvent,
  type OfficeChatDirectConversation,
  type OfficeChatDirectMessage,
  type OfficeChatDirectReadReceipt,
  type OfficeChatMessageReaction,
  type OfficeChatUnreadChat,
  type OfficeChatUser
} from "../lib/api";
import type { Dictionary, Locale } from "../lib/i18n";
import { connectResilientWebSocket, type ResilientWebSocketConnection } from "../lib/resilientWebSocket";
import { useTyping } from "../lib/useTyping";
import { useVisibleReadMarker } from "../lib/useVisibleReadMarker";
import { COMPOSER_FILE_ACCEPT, useComposerAttachments } from "../hooks/useComposerAttachments";
import { useDragDropAttachment } from "../hooks/useDragDropAttachment";
import { ComposerAttachmentsPreview } from "./ComposerAttachmentsPreview";
import { ChatArchivePanel } from "./ChatArchivePanel";
import { ComposerDropOverlay } from "./ComposerDropOverlay";
import { EmojiPicker } from "./EmojiPicker";
import { getAttachmentUploadError, MessageAttachments } from "./MessageAttachments";
import { MessageReactions, reactionsForCurrentUser } from "./MessageReactions";
import { UserAvatar } from "./UserAvatar";
import { TypingIndicator } from "./TypingIndicator";
import { UnreadSeparator } from "./UnreadSeparator";

type DirectChatPanelProps = {
  conversation: OfficeChatDirectConversation;
  currentUser: OfficeChatUser;
  dictionary: Dictionary;
  locale: Locale;
  onMarkRead?: (messageId: string) => void | Promise<void>;
  unread?: OfficeChatUnreadChat;
};

type LiveUpdateStatus = "connected" | "disconnected" | "reconnecting";

export function DirectChatPanel({ conversation, currentUser, dictionary, locale, onMarkRead, unread }: DirectChatPanelProps) {
  const router = useRouter();
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const composeFormRef = useRef<HTMLFormElement | null>(null);
  const composerTextareaRef = useRef<HTMLTextAreaElement | null>(null);
  const messagesListRef = useRef<HTMLDivElement | null>(null);
  const messagesEndRef = useRef<HTMLDivElement | null>(null);
  const socketRef = useRef<ResilientWebSocketConnection | null>(null);
  const panelRef = useRef<HTMLElement | null>(null);
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
  const [archiveOpen, setArchiveOpen] = useState(false);
  const [archivedMessages, setArchivedMessages] = useState<OfficeChatDirectMessage[]>([]);
  const [archiveHasMore, setArchiveHasMore] = useState(false);
  const [archiveLoading, setArchiveLoading] = useState(false);
  const [readReceipt, setReadReceipt] = useState<OfficeChatDirectReadReceipt | null>(null);
  const { handleTypingEvent, notifyTyping, stopTyping, typingUsers } = useTyping(
    socketRef,
    currentUser.id,
    conversation.id
  );
  useVisibleReadMarker({ messages, onMarkRead, panelRef, unread });
  const {
    appendFiles,
    attachments,
    clearAttachments,
    feedback,
    handlePaste,
    removeAttachment,
    selectedFiles,
    totalSize
  } = useComposerAttachments({
    emptyFileError: dictionary.messages.emptyFileNotAllowed,
    onAfterTextInsert: resizeComposer,
    onError: setError,
    onTextChange: setMessageBody,
    pastedMessage: dictionary.messages.clipboardImagePasted,
    textareaRef: composerTextareaRef,
    textValue: messageBody,
    tooManyFilesError: dictionary.messages.tooManyFiles,
    totalSizeError: dictionary.messages.totalAttachmentSizeTooLarge,
    unsupportedFileError: dictionary.messages.unsupportedFileType
  });
  const { dropZoneProps, isFileDragging } = useDragDropAttachment({
    emptyFileError: dictionary.messages.emptyFileNotAllowed,
    failedReadError: dictionary.messages.droppedFileReadError,
    folderError: dictionary.messages.folderAttachmentError,
    onDropFiles: (files) => appendFiles(files),
    onError: setError
  });

  const dateFormatter = useMemo(
    () =>
      new Intl.DateTimeFormat(locale, {
        dateStyle: "medium",
        timeStyle: "short"
      }),
    [locale]
  );
  const newestOwnMessage = useMemo(
    () => [...messages].reverse().find((message) => message.sender_user_id === currentUser.id),
    [currentUser.id, messages]
  );

  function isMessageRead(message: OfficeChatDirectMessage) {
    if (!readReceipt?.last_read_message_id || !readReceipt.last_read_message_created_at) return false;
    const markerTime = Date.parse(readReceipt.last_read_message_created_at);
    const messageTime = Date.parse(message.created_at);
    return markerTime > messageTime || (
      markerTime === messageTime && readReceipt.last_read_message_id.localeCompare(message.id) >= 0
    );
  }

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
    clearAttachments();
    if (fileInputRef.current) fileInputRef.current.value = "";
    setReplyToMessage(null);
    setArchiveOpen(false);
    setArchivedMessages([]);
    setReadReceipt(null);
  }, [conversation.id]);

  useEffect(() => {
    const token = getStoredAccessToken();
    if (!token) {
      router.replace(`/${locale}/login`);
      return;
    }
    void refreshMessages(token).catch(() => setError(dictionary.directMessages.loadError));
    void getDirectReadReceipt(token, conversation.id).then(setReadReceipt).catch(() => setReadReceipt(null));
  }, [dictionary.directMessages.loadError, conversation.id, locale, refreshMessages, router]);

  useEffect(() => {
    if (messages.length === 0) {
      return;
    }

    if (!hasInitialMessageScrollRef.current) {
      hasInitialMessageScrollRef.current = true;
      requestAnimationFrame(() => {
        const separator = messagesListRef.current?.querySelector("[data-unread-separator]");
        if (separator) separator.scrollIntoView({ block: "center" });
        else scrollToLatestMessage("auto");
      });
      return;
    }

    if (shouldScrollToBottomRef.current) {
      shouldScrollToBottomRef.current = false;
      requestAnimationFrame(() => scrollToLatestMessage());
    }
  }, [messages, unread?.first_unread_message_id]);

  useEffect(() => {
    const token = getStoredAccessToken();
    if (!token) {
      router.replace(`/${locale}/login`);
      return;
    }
    const accessToken = token;

    function markIncomingMessage() {
      if (isNearMessagesBottom()) {
        shouldScrollToBottomRef.current = true;
      } else {
        setShowNewMessagesButton(true);
      }
    }

    const connection = connectResilientWebSocket({
      getUrl: () => getDirectWebSocketUrl(accessToken, conversation.id),
      onStatusChange: setLiveUpdateStatus,
      onForbidden: () => setError(dictionary.session.accessDenied),
      onMessage: (event) => {
        try {
          const payload = JSON.parse(event.data as string) as DirectMessageEvent;
          if (payload.type === "typing.updated") {
            handleTypingEvent(payload);
          } else if (payload.type === "direct.read") {
            if (payload.reader_user_id !== currentUser.id) {
              setReadReceipt({
                conversation_id: payload.conversation_id,
                reader_user_id: payload.reader_user_id,
                last_read_message_id: payload.last_read_message_id,
                last_read_message_created_at: payload.last_read_message_created_at,
                read_at: payload.read_at
              });
            }
          } else if (payload.type === "direct.message.reactions.updated") {
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
      }
    });
    socketRef.current = connection;
    return () => {
      stopTyping();
      if (socketRef.current === connection) socketRef.current = null;
      connection();
    };
  }, [conversation.id, currentUser.id, dictionary.session.accessDenied, handleTypingEvent, locale, refreshMessages, router, stopTyping]);

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

  async function openArchive() {
    const token = getStoredAccessToken();
    if (!token) return router.replace(`/${locale}/login`);
    setArchiveLoading(true);
    setError("");
    try {
      const rows = await getArchivedDirectMessages(token, conversation.id);
      setArchivedMessages(rows);
      setArchiveHasMore(rows.length === 50);
      setArchiveOpen(true);
    } catch (caughtError) {
      setError(caughtError instanceof Error ? caughtError.message : dictionary.directMessages.loadError);
    } finally {
      setArchiveLoading(false);
    }
  }

  async function loadMoreArchive() {
    const token = getStoredAccessToken();
    const cursor = archivedMessages.at(-1)?.id;
    if (!token || !cursor) return;
    setArchiveLoading(true);
    try {
      const rows = await getArchivedDirectMessages(token, conversation.id, 50, cursor);
      setArchivedMessages((current) => [...current, ...rows]);
      setArchiveHasMore(rows.length === 50);
    } finally {
      setArchiveLoading(false);
    }
  }

  async function handleSendMessage(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (isSending || (!messageBody.trim() && selectedFiles.length === 0)) {
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
      if (selectedFiles.length > 0) {
        await sendDirectMessageWithAttachments(
          token,
          conversation.id,
          messageBody,
          selectedFiles,
          abortController.signal,
          replyToMessage?.id
        );
      } else {
        await sendDirectMessage(token, conversation.id, messageBody, abortController.signal, replyToMessage?.id);
      }
      setMessageBody("");
      stopTyping();
      setEmojiPickerResetKey((current) => current + 1);
      clearAttachments();
      setReplyToMessage(null);
      if (fileInputRef.current) fileInputRef.current.value = "";
      if (composerTextareaRef.current) {
        composerTextareaRef.current.style.height = "44px";
      }
      shouldScrollToBottomRef.current = true;
      setMessages(await getDirectMessages(token, conversation.id));
      setSuccess(dictionary.directMessages.sendSuccess);
    } catch (caughtError) {
      setError(
        selectedFiles.length > 0
          ? getAttachmentUploadError(caughtError, dictionary)
          : caughtError instanceof Error && caughtError.name !== "AbortError"
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

  async function handleDownloadAttachment(downloadUrl: string, filename: string) {
    const token = getStoredAccessToken();
    if (!token) {
      router.replace(`/${locale}/login`);
      return;
    }
    setError("");
    try {
      const blob = await downloadDirectAttachment(token, downloadUrl);
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
    if (
      event.key === "Enter" &&
      !event.shiftKey &&
      !event.nativeEvent.isComposing &&
      !isSending &&
      (messageBody.trim() || selectedFiles.length > 0)
    ) {
      event.preventDefault();
      composeFormRef.current?.requestSubmit();
    }
  }

  function getReplyPreviewText(reply: NonNullable<OfficeChatDirectMessage["reply_to"]>) {
    if (reply.is_deleted) {
      return dictionary.messages.originalMessageDeleted;
    }
    if (reply.attachment_count > 0 && !reply.body_preview) {
      return dictionary.messages.replyAttachments.replace("{count}", String(reply.attachment_count));
    }
    return reply.body_preview || dictionary.messages.replyPreviewUnavailable;
  }

  function getSelectedReplyPreviewText(message: OfficeChatDirectMessage) {
    if (message.is_deleted) {
      return dictionary.messages.originalMessageDeleted;
    }
    const body = message.body.trim();
    if (body) return body.length > 120 ? `${body.slice(0, 117)}...` : body;
    if (message.attachments.length > 0) {
      return dictionary.messages.replyAttachments.replace("{count}", String(message.attachments.length));
    }
    return dictionary.messages.replyPreviewUnavailable;
  }

  return (
    <section className="messages-panel" aria-label={dictionary.directMessages.ariaLabel} ref={panelRef} {...dropZoneProps}>
      <ComposerDropOverlay dictionary={dictionary} visible={isFileDragging} />
      <div className="dashboard-header messages-toolbar">
        <div>
          <h2 className="section-title">{dictionary.directMessages.title}</h2>
          <p className={`live-status live-status-${liveUpdateStatus}`}>
            {dictionary.messages.liveStatusLabel} {dictionary.messages.liveStatuses[liveUpdateStatus]}
          </p>
        </div>
        <div className="actions">
          <button className="secondary-link" onClick={() => void openArchive()} type="button">{dictionary.retention.messageArchive}</button>
          <button className="secondary-link" onClick={() => void handleRefreshMessages()} type="button">{dictionary.messages.refresh}</button>
        </div>
      </div>

      {success ? <p className="form-success">{success}</p> : null}
      {error ? <p className="form-error">{error}</p> : null}

      {archiveOpen ? (
        <ChatArchivePanel
          dictionary={dictionary}
          hasMore={archiveHasMore}
          loading={archiveLoading}
          locale={locale}
          messages={archivedMessages}
          onClose={() => setArchiveOpen(false)}
          onDownload={(downloadUrl, filename) => void handleDownloadAttachment(downloadUrl, filename)}
          onLoadMore={() => void loadMoreArchive()}
        />
      ) : null}

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
            <Fragment key={message.id}>
              {message.id === unread?.first_unread_message_id ? <UnreadSeparator dictionary={dictionary} /> : null}
            <article className={messageItemClasses}>
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
              <MessageAttachments
                attachments={message.attachments}
                dictionary={dictionary}
                onDownload={(downloadUrl, filename) => void handleDownloadAttachment(downloadUrl, filename)}
              />
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
              {message.id === newestOwnMessage?.id ? (
                <p className="direct-read-receipt">
                  {isMessageRead(message) ? dictionary.unread.read : dictionary.unread.sent}
                </p>
              ) : null}
            </article>
            </Fragment>
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
        {attachments.length > 0 ? (
          <ComposerAttachmentsPreview
            attachments={attachments}
            dictionary={dictionary}
            feedback={feedback}
            onClear={clearAttachments}
            onRemove={removeAttachment}
            totalSize={totalSize}
          />
        ) : null}
        <TypingIndicator dictionary={dictionary} direct users={typingUsers} />
        <div className="messenger-composer-row messenger-composer-row-direct">
          <input
            className="visually-hidden"
            accept={COMPOSER_FILE_ACCEPT}
            multiple
            onChange={(event) => {
              appendFiles(Array.from(event.target.files ?? []));
              event.target.value = "";
            }}
            ref={fileInputRef}
            tabIndex={-1}
            type="file"
          />
          <button
            aria-label={dictionary.messages.attachFiles}
            className="composer-icon-button"
            disabled={isSending}
            onClick={() => fileInputRef.current?.click()}
            title={dictionary.messages.attachFiles}
            type="button"
          >
            📎
          </button>
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
              notifyTyping(event.target.value);
              resizeComposer(event.currentTarget);
            }}
            onBlur={stopTyping}
            onKeyDown={handleComposerKeyDown}
            onPaste={(event) => {
              if (handlePaste(event) && fileInputRef.current) fileInputRef.current.value = "";
            }}
            placeholder={dictionary.messages.body}
            ref={composerTextareaRef}
            required={selectedFiles.length === 0}
            rows={1}
            title={dictionary.messages.clipboardPasteTitle}
            value={messageBody}
          />
          <button className="composer-send-button" disabled={isSending || (!messageBody.trim() && selectedFiles.length === 0)} type="submit">
            {isSending ? dictionary.messages.sending : dictionary.messages.send}
          </button>
        </div>
        <p className="message-compose-hint">
          {dictionary.appShell.composerShortcut} · {dictionary.messages.clipboardPasteHint}
        </p>
      </form>
    </section>
  );
}
