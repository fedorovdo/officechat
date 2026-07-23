"use client";

import { Fragment, FormEvent, KeyboardEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
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
  getPinnedMessages,
  getStoredAccessToken,
  hasPermission,
  isAdminRole,
  pinMessage,
  removeDiscussionMember,
  removeDiscussionMessageReaction,
  sendDiscussionMessage,
  sendDiscussionMessageWithAttachments,
  unpinMessage,
  updatePinnedMessage,
  type DiscussionEvent,
  type OfficeChatDiscussion,
  type OfficeChatDiscussionMessage,
  type OfficeChatMessageContext,
  type OfficeChatPinnedMessage,
  type OfficeChatMessageReaction,
  type OfficeChatPresence,
  type OfficeChatUnreadChat,
  type OfficeChatUser
} from "../lib/api";
import type { Dictionary, Locale } from "../lib/i18n";
import { applyDeletedMessageEvent } from "../lib/message-privacy";
import { connectResilientWebSocket, type ResilientWebSocketConnection } from "../lib/resilientWebSocket";
import { useTyping } from "../lib/useTyping";
import { scrollUnreadMessageIntoView, useVisibleReadMarker } from "../lib/useVisibleReadMarker";
import { COMPOSER_FILE_ACCEPT, useComposerAttachments } from "../hooks/useComposerAttachments";
import { useDragDropAttachment } from "../hooks/useDragDropAttachment";
import { ComposerAttachmentsPreview } from "./ComposerAttachmentsPreview";
import { ChatArchivePanel } from "./ChatArchivePanel";
import { ComposerDropOverlay } from "./ComposerDropOverlay";
import { EmojiPicker } from "./EmojiPicker";
import { getAttachmentUploadError, MessageAttachments } from "./MessageAttachments";
import { MessageReactions, reactionsForCurrentUser } from "./MessageReactions";
import { MessageActionsMenu } from "./MessageActionsMenu";
import { PinnedMessages } from "./PinnedMessages";
import { UserAvatar } from "./UserAvatar";
import { TypingIndicator } from "./TypingIndicator";
import { PresenceStatus } from "./PresenceStatus";
import { UnreadSeparator } from "./UnreadSeparator";

type DiscussionPanelProps = {
  currentUser: OfficeChatUser;
  dictionary: Dictionary;
  discussionId: string;
  locale: Locale;
  onClose: () => void;
  presenceByUserId?: Record<string, OfficeChatPresence>;
  onMarkRead?: (messageId: string) => boolean | void | Promise<boolean | void>;
  unread?: OfficeChatUnreadChat;
  messageContext?: OfficeChatMessageContext | null;
  onContextClosed?: () => void;
  onContextExpand?: (before: number, after: number) => void | Promise<void>;
  onJumpToMessage?: (messageId: string) => void | Promise<void>;
};

type LiveUpdateStatus = "connected" | "disconnected" | "reconnecting";

export function DiscussionPanel({
  currentUser,
  dictionary,
  discussionId,
  locale,
  onClose,
  presenceByUserId = {},
  onMarkRead,
  unread,
  messageContext,
  onContextClosed,
  onContextExpand,
  onJumpToMessage
}: DiscussionPanelProps) {
  const router = useRouter();
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const composeFormRef = useRef<HTMLFormElement | null>(null);
  const composerTextareaRef = useRef<HTMLTextAreaElement | null>(null);
  const socketRef = useRef<ResilientWebSocketConnection | null>(null);
  const panelRef = useRef<HTMLElement | null>(null);
  const messagesListRef = useRef<HTMLDivElement | null>(null);
  const historicalTargetRef = useRef<string | null>(null);
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
  const [historicalTargetId, setHistoricalTargetId] = useState<string | null>(null);
  const [highlightedMessageId, setHighlightedMessageId] = useState<string | null>(null);
  const [showNewMessagesButton, setShowNewMessagesButton] = useState(false);
  const [pins, setPins] = useState<OfficeChatPinnedMessage[]>([]);
  const [pinsOpen, setPinsOpen] = useState(false);
  const [pinDraftMessage, setPinDraftMessage] = useState<OfficeChatDiscussionMessage | null>(null);
  const [pinNote, setPinNote] = useState("");
  const { handleTypingEvent, notifyTyping, stopTyping, typingUsers } = useTyping(
    socketRef,
    currentUser.id,
    discussionId
  );
  useVisibleReadMarker({
    currentUserId: currentUser.id,
    messages,
    onMarkRead,
    scrollContainerRef: panelRef,
    unread: historicalTargetId ? undefined : unread
  });
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
  const canPinMessages = hasPermission(currentUser, "can_pin_messages");

  function resizeComposer(textarea: HTMLTextAreaElement) {
    textarea.style.height = "0px";
    const nextHeight = Math.min(textarea.scrollHeight, 160);
    textarea.style.height = `${nextHeight}px`;
    textarea.style.overflowY = textarea.scrollHeight > 160 ? "auto" : "hidden";
  }

  const refreshDiscussion = useCallback(async (token: string) => {
    const [loadedDiscussion, loadedMessages, loadedPins] = await Promise.all([
      getDiscussion(token, discussionId),
      getDiscussionMessages(token, discussionId),
      getPinnedMessages(token, "discussion", discussionId)
    ]);
    setDiscussion(loadedDiscussion);
    setMessages(loadedMessages);
    setPins(loadedPins);
  }, [discussionId]);

  const refreshPins = useCallback(async (token: string) => {
    setPins(await getPinnedMessages(token, "discussion", discussionId));
  }, [discussionId]);

  function applyPinnedMessage(pin: OfficeChatPinnedMessage) {
    setPins((current) => [pin, ...current.filter((item) => item.id !== pin.id)]);
    setMessages((current) =>
      current.map((message) =>
        message.id === pin.message_id
          ? { ...message, is_pinned: true, pin_id: pin.id, pinned_at: pin.pinned_at }
          : message
      )
    );
  }

  function applyUnpinnedMessage(pinId: string, messageId: string) {
    setPins((current) => current.filter((pin) => pin.id !== pinId));
    setMessages((current) =>
      current.map((message) =>
        message.id === messageId ? { ...message, is_pinned: false, pin_id: null, pinned_at: null } : message
      )
    );
  }

  function getMessagePinId(message: OfficeChatDiscussionMessage) {
    return message.pin_id ?? pins.find((pin) => pin.message_id === message.id)?.id ?? null;
  }

  useEffect(() => {
    setMessageBody("");
    historicalTargetRef.current = null;
    setHistoricalTargetId(null);
    setHighlightedMessageId(null);
    setShowNewMessagesButton(false);
    clearAttachments();
    setArchiveOpen(false);
    setArchivedMessages([]);
    setPinsOpen(false);
    setPinDraftMessage(null);
    setPinNote("");
    if (fileInputRef.current) fileInputRef.current.value = "";
  }, [discussionId]);

  useEffect(() => {
    if (!unread?.first_unread_message_id || messages.length === 0) return;
    requestAnimationFrame(() => {
      scrollUnreadMessageIntoView(messagesListRef.current, unread.first_unread_message_id);
    });
  }, [messages, unread?.first_unread_message_id]);

  useEffect(() => {
    const token = getStoredAccessToken();
    if (!token) {
      router.replace(`/${locale}/login`);
      return;
    }
    if (!messageContext || messageContext.chat_id !== discussionId) {
      void refreshDiscussion(token).catch((caughtError) => {
        setError(caughtError instanceof Error ? caughtError.message : dictionary.discussions.loadError);
      });
    } else {
      void getDiscussion(token, discussionId).then(setDiscussion).catch(() => undefined);
    }
  }, [dictionary.discussions.loadError, discussionId, locale, messageContext?.target_message_id, refreshDiscussion, router]);

  useEffect(() => {
    if (!messageContext || messageContext.chat_type !== "discussion" || messageContext.chat_id !== discussionId) return;
    historicalTargetRef.current = messageContext.target_message_id;
    setHistoricalTargetId(messageContext.target_message_id);
    setHighlightedMessageId(messageContext.target_message_id);
    setMessages(messageContext.messages as OfficeChatDiscussionMessage[]);
    setShowNewMessagesButton(messageContext.has_more_after);
    requestAnimationFrame(() => {
      messagesListRef.current
        ?.querySelector(`[data-message-id="${messageContext.target_message_id}"]`)
        ?.scrollIntoView({ block: "center" });
    });
    const timer = window.setTimeout(() => setHighlightedMessageId(null), 3200);
    return () => window.clearTimeout(timer);
  }, [discussionId, messageContext]);

  useEffect(() => {
    const token = getStoredAccessToken();
    if (!token) {
      router.replace(`/${locale}/login`);
      return;
    }
    const accessToken = token;
    const connection = connectResilientWebSocket({
      getUrl: () => getDiscussionWebSocketUrl(accessToken, discussionId),
      onStatusChange: setLiveUpdateStatus,
      onForbidden: () => setError(dictionary.session.accessDenied),
      onMessage: (event) => {
        try {
          const payload = JSON.parse(event.data as string) as DiscussionEvent;
          if (payload.type === "typing.updated") {
            handleTypingEvent(payload);
          } else if (payload.type === "discussion.message.reactions.updated") {
            const reactions = reactionsForCurrentUser(payload.reactions, currentUser.id);
            setMessages((current) =>
              current.map((message) => (message.id === payload.message_id ? { ...message, reactions } : message))
            );
          } else if (payload.type === "message.pinned" || payload.type === "message.pin_updated") {
            applyPinnedMessage(payload.pin);
          } else if (payload.type === "message.unpinned") {
            applyUnpinnedMessage(payload.pin_id, payload.message_id);
          } else if (payload.type === "discussion.message.deleted") {
            setMessages((current) => applyDeletedMessageEvent(current, payload.message));
            setArchivedMessages((current) => applyDeletedMessageEvent(current, payload.message));
            setPinDraftMessage((current) => current?.id === payload.message.id ? null : current);
            setEditingMessageId((current) => current === payload.message.id ? null : current);
            setEditingMessageBody("");
            void refreshPins(accessToken);
            if (historicalTargetRef.current) setShowNewMessagesButton(true);
            else void refreshDiscussion(accessToken);
          } else if (payload.type.startsWith("discussion.")) {
            if (historicalTargetRef.current) setShowNewMessagesButton(true);
            else void refreshDiscussion(accessToken);
          }
        } catch {
          if (historicalTargetRef.current) setShowNewMessagesButton(true);
          else void refreshDiscussion(accessToken);
        }
      }
    });
    socketRef.current = connection;
    return () => {
      stopTyping();
      if (socketRef.current === connection) socketRef.current = null;
      connection();
    };
  }, [currentUser.id, dictionary.session.accessDenied, discussionId, handleTypingEvent, locale, refreshDiscussion, refreshPins, router, stopTyping]);

  async function returnToLatest() {
    const token = getStoredAccessToken();
    if (!token) return;
    historicalTargetRef.current = null;
    setHistoricalTargetId(null);
    setHighlightedMessageId(null);
    setShowNewMessagesButton(false);
    await refreshDiscussion(token);
    requestAnimationFrame(() => {
      const list = messagesListRef.current;
      if (list) list.scrollTo({ top: list.scrollHeight, behavior: "smooth" });
    });
    onContextClosed?.();
  }

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
      stopTyping();
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
      await refreshDiscussion(token);
      setSuccess(dictionary.discussions.deleteSuccess);
    } catch (caughtError) {
      setError(caughtError instanceof Error ? caughtError.message : dictionary.discussions.deleteError);
    }
  }

  async function handlePinMessage() {
    const token = getStoredAccessToken();
    if (!token || !pinDraftMessage) {
      router.replace(`/${locale}/login`);
      return;
    }
    setError("");
    setSuccess("");
    try {
      const pin = await pinMessage(token, "discussion", discussionId, pinDraftMessage.id, pinNote);
      setPinDraftMessage(null);
      setPinNote("");
      applyPinnedMessage(pin);
      setSuccess(dictionary.pins.pinSuccess);
    } catch (caughtError) {
      setError(caughtError instanceof Error ? caughtError.message : dictionary.pins.pinError);
    }
  }

  async function handleUnpinMessage(pinId: string) {
    const token = getStoredAccessToken();
    if (!token) {
      router.replace(`/${locale}/login`);
      return;
    }
    setError("");
    setSuccess("");
    try {
      const pinnedMessage = pins.find((pin) => pin.id === pinId);
      await unpinMessage(token, pinId);
      if (pinnedMessage) {
        applyUnpinnedMessage(pinId, pinnedMessage.message_id);
      } else {
        await refreshPins(token);
      }
      setSuccess(dictionary.pins.unpinSuccess);
    } catch (caughtError) {
      setError(caughtError instanceof Error ? caughtError.message : dictionary.pins.unpinError);
    }
  }

  async function handleUpdatePinNote(pinId: string, note: string) {
    const token = getStoredAccessToken();
    if (!token) return;
    setError("");
    try {
      const pin = await updatePinnedMessage(token, pinId, note);
      applyPinnedMessage(pin);
      setSuccess(dictionary.pins.noteSuccess);
    } catch (caughtError) {
      setError(caughtError instanceof Error ? caughtError.message : dictionary.pins.noteError);
    }
  }

  function handleJumpToPinnedMessage(messageId: string) {
    if (onJumpToMessage) {
      void onJumpToMessage(messageId);
      return;
    }
    messagesListRef.current?.querySelector(`[data-message-id="${messageId}"]`)?.scrollIntoView({ block: "center" });
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
    <aside className="discussion-panel" aria-label={dictionary.discussions.ariaLabel} ref={panelRef} {...dropZoneProps}>
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

      <PinnedMessages
        canPin={canPinMessages}
        dictionary={dictionary}
        isOpen={pinsOpen}
        locale={locale}
        onClose={() => setPinsOpen(false)}
        onJump={handleJumpToPinnedMessage}
        onOpen={() => setPinsOpen(true)}
        onUnpin={(pinId) => void handleUnpinMessage(pinId)}
        onUpdateNote={(pinId, note) => void handleUpdatePinNote(pinId, note)}
        pins={pins}
      />

      {pinDraftMessage ? (
        <form className="pin-draft-panel" onSubmit={(event) => {
          event.preventDefault();
          void handlePinMessage();
        }}>
          <div>
            <strong>{dictionary.pins.pinMessage}</strong>
            <p>{pinDraftMessage.body.trim() || dictionary.messages.replyPreviewUnavailable}</p>
            <p className="note">{dictionary.pins.attachmentWarning}</p>
          </div>
          <input className="field-input" maxLength={300} onChange={(event) => setPinNote(event.target.value)} placeholder={dictionary.pins.notePlaceholder} value={pinNote} />
          <div className="actions">
            <button className="primary-button" type="submit">{dictionary.pins.pin}</button>
            <button className="table-action" onClick={() => {
              setPinDraftMessage(null);
              setPinNote("");
            }} type="button">{dictionary.pins.cancel}</button>
          </div>
        </form>
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
                      <PresenceStatus
                        dictionary={dictionary}
                        locale={locale}
                        presence={presenceByUserId[member.user_id]}
                      />
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
        <div className="discussion-messages-heading">
          <h3 className="compact-title">{dictionary.discussions.messages}</h3>
          {showNewMessagesButton || historicalTargetId ? (
            <button className="table-action" onClick={() => void returnToLatest()} type="button">
              {dictionary.messageSearch.jumpLatest}
            </button>
          ) : null}
        </div>
        <div className="discussion-messages-list" ref={messagesListRef}>
          {messageContext?.has_more_before ? (
            <button className="context-load-button" onClick={() => {
              const targetIndex = messageContext.messages.findIndex((message) => message.id === messageContext.target_message_id);
              void onContextExpand?.(Math.max(20, targetIndex) + 20, messageContext.messages.length - targetIndex - 1);
            }} type="button">{dictionary.messageSearch.loadOlder}</button>
          ) : null}
          {messages.map((message) => {
            const canEdit = message.sender_user_id === currentUser.id && !message.is_deleted;
            const canDelete = (message.sender_user_id === currentUser.id || canDeleteOthers) && !message.is_deleted;
            const canPinThisMessage = canPinMessages && !message.is_deleted && !message.is_archived;
            return (
              <Fragment key={message.id}>
                {message.id === unread?.first_unread_message_id ? <UnreadSeparator dictionary={dictionary} /> : null}
              <article
                className={`${message.is_deleted ? "discussion-message discussion-message-deleted" : "discussion-message"}${message.id === highlightedMessageId ? " message-search-target" : ""}`}
                data-message-id={message.id}
              >
                <div className="message-meta">
                  <UserAvatar className="message-sender-avatar" size={28} user={message.sender} />
                  <strong>{message.sender.display_name}</strong>
                  <span>@{message.sender.username}</span>
                  <span>{dateFormatter.format(new Date(message.created_at))}</span>
                  {message.edited_at ? <span>{dictionary.messages.edited}</span> : null}
                  {message.is_pinned ? <span className="pin-badge">{dictionary.pins.pinned}</span> : null}
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
                  isDeleted={message.is_deleted}
                  onDownload={(downloadUrl, filename) => void handleDownloadAttachment(downloadUrl, filename)}
                />
                {!message.is_deleted ? (
                  <MessageReactions
                    canAddReaction
                    dictionary={dictionary}
                    onAdd={(emoji) => handleAddReaction(message.id, emoji)}
                    onRemove={(emoji) => handleRemoveReaction(message.id, emoji)}
                    reactions={message.reactions}
                  />
                ) : null}
                {!message.is_deleted ? (
                  <div className="message-actions">
                    <MessageActionsMenu
                      canDelete={canDelete}
                      canEdit={canEdit}
                      canPin={canPinThisMessage}
                      dictionary={dictionary}
                      isPinned={message.is_pinned}
                      onDelete={() => void handleDeleteMessage(message.id)}
                      onEdit={() => {
                        setEditingMessageId(message.id);
                        setEditingMessageBody(message.body);
                      }}
                      onPinToggle={() => {
                        const pinId = getMessagePinId(message);
                        if (pinId) void handleUnpinMessage(pinId);
                        else setPinDraftMessage(message);
                      }}
                    />
                  </div>
                ) : null}
              </article>
              </Fragment>
            );
          })}
          {messageContext?.has_more_after ? (
            <button className="context-load-button" onClick={() => {
              const targetIndex = messageContext.messages.findIndex((message) => message.id === messageContext.target_message_id);
              void onContextExpand?.(targetIndex, messageContext.messages.length - targetIndex - 1 + 20);
            }} type="button">{dictionary.messageSearch.loadNewer}</button>
          ) : null}
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
        <TypingIndicator dictionary={dictionary} users={typingUsers} />
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
              notifyTyping(event.target.value);
              resizeComposer(event.currentTarget);
            }}
            onBlur={stopTyping}
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
