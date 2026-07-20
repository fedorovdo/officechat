"use client";

import type {
  OfficeChatAttachment,
  OfficeChatDirectoryUser,
  OfficeChatMessageReaction
} from "../lib/api";
import type { Dictionary, Locale } from "../lib/i18n";
import { MessageAttachments } from "./MessageAttachments";
import { UserAvatar } from "./UserAvatar";

export type ArchivedChatMessage = {
  id: string;
  body: string;
  is_deleted: boolean;
  is_archived: boolean;
  archived_at: string | null;
  created_at: string;
  sender: OfficeChatDirectoryUser;
  attachments: OfficeChatAttachment[];
  reactions: OfficeChatMessageReaction[];
};

type ChatArchivePanelProps = {
  dictionary: Dictionary;
  hasMore: boolean;
  loading: boolean;
  locale: Locale;
  messages: ArchivedChatMessage[];
  onClose: () => void;
  onDownload: (downloadUrl: string, filename: string) => void;
  onLoadMore: () => void;
};

export function ChatArchivePanel({
  dictionary,
  hasMore,
  loading,
  locale,
  messages,
  onClose,
  onDownload,
  onLoadMore
}: ChatArchivePanelProps) {
  const formatter = new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" });
  return (
    <section className="chat-archive-panel" aria-label={dictionary.retention.messageArchive}>
      <div className="dashboard-header messages-toolbar">
        <div>
          <h2 className="section-title">{dictionary.retention.messageArchive}</h2>
          <p className="muted">{dictionary.retention.archived}</p>
        </div>
        <button className="secondary-link" onClick={onClose} type="button">{dictionary.retention.closeArchive}</button>
      </div>
      <div className="archive-messages-list">
        {messages.length === 0 && !loading ? <p className="empty-state">{dictionary.retention.noArchived}</p> : null}
        {messages.map((message) => (
          <article className="message-item message-item-archived" key={message.id}>
            <div className="message-meta">
              <UserAvatar className="message-sender-avatar" size={28} user={message.sender} />
              <strong>{message.sender.display_name}</strong>
              <span>@{message.sender.username}</span>
              <span>{formatter.format(new Date(message.created_at))}</span>
            </div>
            <span className="archive-badge">
              {dictionary.retention.archivedAt}: {message.archived_at ? formatter.format(new Date(message.archived_at)) : "-"}
            </span>
            <p className={message.is_deleted ? "message-body deleted-message" : "message-body"}>
              {message.is_deleted ? dictionary.messages.deletedMessage : message.body}
            </p>
            <MessageAttachments
              attachments={message.attachments}
              dictionary={dictionary}
              isDeleted={message.is_deleted}
              onDownload={onDownload}
            />
            {!message.is_deleted && message.reactions.length > 0 ? (
              <div className="archive-reactions">
                {message.reactions.map((reaction) => (
                  <span key={reaction.emoji}>{reaction.emoji} {reaction.count}</span>
                ))}
              </div>
            ) : null}
          </article>
        ))}
        {hasMore ? <button className="secondary-link" disabled={loading} onClick={onLoadMore} type="button">{dictionary.retention.loadMore}</button> : null}
      </div>
    </section>
  );
}
