"use client";

import { FormEvent, KeyboardEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";

import {
  addDiscussionMessageReaction,
  addDiscussionMember,
  deleteDiscussionMessage,
  downloadDiscussionAttachment,
  editDiscussionMessage,
  getArchivedDiscussionMessages,
  getDiscussion,
  getDiscussionMessages,
  getDiscussionWebSocketUrl,
  getStoredAccessToken,
  isAdminRole,
  removeDiscussionMember,
  removeDiscussionMessageReaction,
  sendDiscussionMessage,
  sendDiscussionMessageWithAttachments,
  type DiscussionEvent,
  type OfficeChatDiscussion,
  type OfficeChatDiscussionMessage,
  type OfficeChatMessageReaction,
  type OfficeChatUser
} from "../lib/api";
import type { Dictionary, Locale } from "../lib/i18n";
import { connectResilientWebSocket } from "../lib/resilientWebSocket";
import { COMPOSER_FILE_ACCEPT, useComposerAttachments } from "../hooks/useComposerAttachments";
import { useDragDropAttachment } from "../hooks/useDragDropAttachment";
import { ComposerAttachmentsPreview } from "./ComposerAttachmentsPreview";
import { ChatArchivePanel } from "./ChatArchivePanel";
import { ComposerDropOverlay } from "./ComposerDropOverlay";
import { EmojiPicker } from "./EmojiPicker";
import { getAttachmentUploadError, MessageAttachments } from "./MessageAttachments";
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
  const fileInputRef = useRef<HTMLInputElement | null>(null);
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
  const [archiveOpen, setArchiveOpen] = useState(false);
  const [archivedMessages, setArchivedMessages] = useState<OfficeChatDiscussionMessage[]>([]);
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
    setMessageBody("");
    clearAttachments();
    setArchiveOpen(false);
    setArchivedMessages([]);
    if (fileInputRef.current) fileInputRef.current.value = "";
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
    return connectResilientWebSocket({
      getUrl: () => getDiscussionWebSocketUrl(accessToken, discussionId),
      onStatusChange: setLiveUpdateStatus,
      onForbidden: () => setError(dictionary.session.accessDenied),
      onMessage: (event) => {
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
      }
    });
  }, [currentUser.id, dictionary.session.accessDenied, discussionId, locale, refreshDiscussion, router]);

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

  async function openArchive() {
    const token = getStoredAccessToken();
    if (!token) return router.replace(`/${locale}/login`);
    setArchiveLoading(true);
    setError("");
    try {
      const rows = await getArchivedDiscussionMessages(token, discussionId);
      setArchivedMessages(rows);
      setArchiveHasMore(rows.length === 50);
      setArchiveOpen(true);
    } catch (caughtError) {
      setError(caughtError instanceof Error ? caughtError.message : dictionary.discussions.loadError);
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
      const rows = await getArchivedDiscussionMessages(token, discussionId, 50, cursor);
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
    try {
      if (selectedFiles.length > 0) {
        await sendDiscussionMessageWithAttachments(token, discussionId, messageBody, selectedFiles);
      } else {
        await sendDiscussionMessage(token, discussionId, messageBody);
      }
      setMessageBody("");
      setEmojiPickerResetKey((current) => current + 1);
      clearAttachments();
      if (fileInputRef.current) fileInputRef.current.value = "";
      if (composerTextareaRef.current) composerTextareaRef.current.style.height = "42px";
      setMessages(await getDiscussionMessages(token, discussionId));
      setSuccess(dictionary.discussions.sendSuccess);
    } catch (caughtError) {
      setError(
        selectedFiles.length > 0
          ? getAttachmentUploadError(caughtError, dictionary)
          : caughtError instanceof Error
            ? caughtError.message
            : dictionary.discussions.sendError
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

  async function handleDownloadAttachment(downloadUrl: string, filename: string) {
    const token = getStoredAccessToken();
    if (!token) {
      router.replace(`/${locale}/login`);
      return;
    }
    setError("");
    try {
      const blob = await downloadDiscussionAttachment(token, downloadUrl);
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
      (messageBody.trim() || selectedFiles.length > 0)
    ) {
      event.preventDefault();
      composeFormRef.current?.requestSubmit();
    }
  }

  const currentMembership = discussion?.members.find((member) => member.user_id === currentUser.id);
  const canDeleteOthers = currentMembership?.role === "owner" || isAdminRole(currentUser.role);

  return (
    <aside className="discussion-panel" aria-label={dictionary.discussions.ariaLabel} {...dropZoneProps}>
      <ComposerDropOverlay dictionary={dictionary} visible={isFileDragging} />
      <div className="dashboard-header discussion-panel-header">
        <div>
          <p className="eyebrow">{dictionary.discussions.eyebrow}</p>
          <h2 className="section-title">{discussion?.title || dictionary.discussions.title}</h2>
          <p className={`live-status live-status-${liveUpdateStatus}`}>
            {dictionary.messages.liveStatusLabel} {dictionary.messages.liveStatuses[liveUpdateStatus]}
          </p>
        </div>
        <div className="actions">
          <button className="table-action" onClick={() => void openArchive()} type="button">{dictionary.retention.messageArchive}</button>
          <button className="table-action" onClick={onClose} type="button">{dictionary.discussions.close}</button>
        </div>
      </div>

      {error ? <p className="form-error">{error}</p> : null}
      {success ? <p className="form-success">{success}</p> : null}

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
        <div className="discussion-composer-row">
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
            onPaste={(event) => {
              if (handlePaste(event) && fileInputRef.current) fileInputRef.current.value = "";
            }}
            placeholder={dictionary.discussions.message}
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
        <p className="message-compose-hint">{dictionary.messages.clipboardPasteHint}</p>
      </form>
    </aside>
  );
}
