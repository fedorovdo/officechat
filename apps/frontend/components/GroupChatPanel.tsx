"use client";

import { FormEvent, KeyboardEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";

import {
  addGroupMessageReaction,
  deleteGroupMessage,
  downloadAttachment,
  editGroupMessage,
  getArchivedGroupMessages,
  getGroupMessages,
  getGroupWebSocketUrl,
  getStoredAccessToken,
  removeGroupMessageReaction,
  sendGroupMessage,
  sendGroupMessageWithAttachments,
  type GroupMessageEvent,
  type OfficeChatMessage,
  type OfficeChatMessageReaction,
  type OfficeChatUser
} from "../lib/api";
import type { Dictionary, Locale } from "../lib/i18n";
import { COMPOSER_FILE_ACCEPT, useComposerAttachments } from "../hooks/useComposerAttachments";
import { useDragDropAttachment } from "../hooks/useDragDropAttachment";
import { ComposerAttachmentsPreview } from "./ComposerAttachmentsPreview";
import { ChatArchivePanel } from "./ChatArchivePanel";
import { ComposerDropOverlay } from "./ComposerDropOverlay";
import { EmojiPicker } from "./EmojiPicker";
import { getAttachmentUploadError, MessageAttachments } from "./MessageAttachments";
import { MessageReactions, reactionsForCurrentUser } from "./MessageReactions";
import { UserAvatar } from "./UserAvatar";

type GroupChatPanelProps = {
  canModerateMessages: boolean;
  currentUser: OfficeChatUser;
  dictionary: Dictionary;
  groupId: string;
  locale: Locale;
  onDiscuss?: (message: OfficeChatMessage) => void;
};

type LiveUpdateStatus = "connected" | "disconnected" | "reconnecting";

export function GroupChatPanel({
  canModerateMessages,
  currentUser,
  dictionary,
  groupId,
  locale,
  onDiscuss
}: GroupChatPanelProps) {
  const router = useRouter();
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const composeFormRef = useRef<HTMLFormElement | null>(null);
  const composerTextareaRef = useRef<HTMLTextAreaElement | null>(null);
  const messagesListRef = useRef<HTMLDivElement | null>(null);
  const messagesEndRef = useRef<HTMLDivElement | null>(null);
  const shouldScrollToBottomRef = useRef(false);
  const hasInitialMessageScrollRef = useRef(false);
  const [messages, setMessages] = useState<OfficeChatMessage[]>([]);
  const [messageBody, setMessageBody] = useState("");
  const [emojiPickerResetKey, setEmojiPickerResetKey] = useState(0);
  const [replyToMessage, setReplyToMessage] = useState<OfficeChatMessage | null>(null);
  const [editingMessageId, setEditingMessageId] = useState<string | null>(null);
  const [editingMessageBody, setEditingMessageBody] = useState("");
  const [isSending, setIsSending] = useState(false);
  const [liveUpdateStatus, setLiveUpdateStatus] = useState<LiveUpdateStatus>("disconnected");
  const [showNewMessagesButton, setShowNewMessagesButton] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [archiveOpen, setArchiveOpen] = useState(false);
  const [archivedMessages, setArchivedMessages] = useState<OfficeChatMessage[]>([]);
  const [archiveHasMore, setArchiveHasMore] = useState(false);
  const [archiveLoading, setArchiveLoading] = useState(false);
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
      setMessages(await getGroupMessages(token, groupId));
    },
    [groupId]
  );

  useEffect(() => {
    hasInitialMessageScrollRef.current = false;
    shouldScrollToBottomRef.current = false;
    setShowNewMessagesButton(false);
    setReplyToMessage(null);
    setArchiveOpen(false);
    setArchivedMessages([]);
    clearAttachments();
    if (fileInputRef.current) fileInputRef.current.value = "";
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
      websocket = new WebSocket(getGroupWebSocketUrl(accessToken, groupId));
      websocket.onopen = () => {
        reconnectAttempts = 0;
        setLiveUpdateStatus("connected");
      };
      websocket.onmessage = (event) => {
        try {
          const payload = JSON.parse(event.data as string) as GroupMessageEvent;
          if (payload.type === "message.reactions.updated") {
            const reactions = reactionsForCurrentUser(payload.reactions, currentUser.id);
            setMessages((current) =>
              current.map((message) => (message.id === payload.message_id ? { ...message, reactions } : message))
            );
          } else if (payload.type.startsWith("message.")) {
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
  }, [currentUser.id, groupId, locale, refreshMessages, router]);

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
    return applyReactionUpdate(messageId, await addGroupMessageReaction(token, groupId, messageId, emoji));
  }

  async function handleRemoveReaction(messageId: string, emoji: string) {
    const token = getStoredAccessToken();
    if (!token) {
      router.replace(`/${locale}/login`);
      throw new Error(dictionary.messages.reactions.updateError);
    }
    return applyReactionUpdate(messageId, await removeGroupMessageReaction(token, groupId, messageId, emoji));
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
      setError(caughtError instanceof Error ? caughtError.message : dictionary.messages.loadError);
    }
  }

  async function openArchive() {
    const token = getStoredAccessToken();
    if (!token) return router.replace(`/${locale}/login`);
    setArchiveLoading(true);
    setError("");
    try {
      const rows = await getArchivedGroupMessages(token, groupId);
      setArchivedMessages(rows);
      setArchiveHasMore(rows.length === 50);
      setArchiveOpen(true);
    } catch (caughtError) {
      setError(caughtError instanceof Error ? caughtError.message : dictionary.messages.loadError);
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
      const rows = await getArchivedGroupMessages(token, groupId, 50, cursor);
      setArchivedMessages((current) => [...current, ...rows]);
      setArchiveHasMore(rows.length === 50);
    } finally {
      setArchiveLoading(false);
    }
  }

  function getReplyPreviewText(reply: NonNullable<OfficeChatMessage["reply_to"]>) {
    if (reply.is_deleted) {
      return dictionary.messages.originalMessageDeleted;
    }
    if (reply.attachment_count > 0 && !reply.body_preview) {
      return dictionary.messages.replyAttachments.replace("{count}", String(reply.attachment_count));
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
      return dictionary.messages.replyAttachments.replace("{count}", String(message.attachments.length));
    }
    return dictionary.messages.replyPreviewUnavailable;
  }

  function renderMessageBody(message: OfficeChatMessage) {
    const mentionedUsernames = new Set(message.mentions.map((mention) => mention.username.toLowerCase()));
    return message.body.split(/(@[\p{L}\p{N}_-]+(?:\.[\p{L}\p{N}_-]+)*)/gu).map((part, index) => {
      const username = part.startsWith("@") ? part.slice(1).toLowerCase() : "";
      return mentionedUsernames.has(username) ? (
        <mark className="message-mention" key={`${message.id}-${index}`}>
          {part}
        </mark>
      ) : (
        part
      );
    });
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
    try {
      if (selectedFiles.length > 0) {
        await sendGroupMessageWithAttachments(token, groupId, messageBody, selectedFiles, replyToMessage?.id);
      } else {
        await sendGroupMessage(token, groupId, messageBody, replyToMessage?.id);
      }
      setMessageBody("");
      setEmojiPickerResetKey((current) => current + 1);
      clearAttachments();
      setReplyToMessage(null);
      if (fileInputRef.current) {
        fileInputRef.current.value = "";
      }
      if (composerTextareaRef.current) {
        composerTextareaRef.current.style.height = "44px";
      }
      shouldScrollToBottomRef.current = true;
      setMessages(await getGroupMessages(token, groupId));
      setSuccess(dictionary.messages.sendSuccess);
    } catch (caughtError) {
      setError(
        selectedFiles.length > 0
          ? getAttachmentUploadError(caughtError, dictionary)
          : caughtError instanceof Error
            ? caughtError.message
            : dictionary.messages.sendError
      );
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

  return (
    <section className="messages-panel" aria-label={dictionary.messages.ariaLabel} {...dropZoneProps}>
      <ComposerDropOverlay dictionary={dictionary} visible={isFileDragging} />
      <div className="dashboard-header messages-toolbar">
        <div>
          <h2 className="section-title">{dictionary.messages.title}</h2>
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
                <UserAvatar className="message-sender-avatar" size={28} user={message.sender} />
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
                    {message.is_deleted ? dictionary.messages.deletedMessage : renderMessageBody(message)}
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
                  {onDiscuss ? (
                    <button className="table-action" onClick={() => onDiscuss(message)} type="button">
                      {dictionary.discussions.discuss}
                    </button>
                  ) : null}
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
        <div className="messenger-composer-row">
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
            onClick={() => fileInputRef.current?.click()}
            title={dictionary.messages.attachFiles}
            type="button"
          >
            +
          </button>
          <EmojiPicker
            contextKey={groupId}
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
          {dictionary.messages.mentionHint} · {dictionary.appShell.composerShortcut} · {dictionary.messages.clipboardPasteHint}
        </p>
      </form>
    </section>
  );
}
