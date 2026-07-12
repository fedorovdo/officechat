"use client";

import type { OfficeChatNotification } from "../lib/api";
import type { Dictionary, Locale } from "../lib/i18n";
import { formatUnreadCount } from "../lib/useUnreadStore";
import { UserAvatar } from "./UserAvatar";

export type NotificationCenterFilter = "all" | "unread" | "mentions" | "replies" | "announcements" | "system";

type NotificationCenterProps = {
  dictionary: Dictionary;
  filter: NotificationCenterFilter;
  isOpen: boolean;
  items: OfficeChatNotification[];
  locale: Locale;
  unreadCount: number;
  onClose: () => void;
  onDismiss: (notification: OfficeChatNotification) => void;
  onFilterChange: (filter: NotificationCenterFilter) => void;
  onLoadMore: () => void;
  onMarkAllRead: () => void;
  onMarkRead: (notification: OfficeChatNotification) => void;
  onOpen: (notification: OfficeChatNotification) => void;
  hasMore: boolean;
  isLoading: boolean;
};

const filters: NotificationCenterFilter[] = ["all", "unread", "mentions", "replies", "announcements", "system"];

function notificationTitle(dictionary: Dictionary, notification: OfficeChatNotification) {
  const titles = dictionary.notifications.titles;
  return notification.type in titles
    ? titles[notification.type as keyof typeof titles]
    : dictionary.notifications.titles.system;
}

function sourceLabel(dictionary: Dictionary, notification: OfficeChatNotification) {
  if (notification.chat_type === "group") return dictionary.messageSearch.chatTypes.group;
  if (notification.chat_type === "direct") return dictionary.messageSearch.chatTypes.direct;
  if (notification.chat_type === "discussion") return dictionary.messageSearch.chatTypes.discussion;
  if (notification.category === "announcements") return dictionary.announcements.title;
  if (notification.category === "pins") return dictionary.pins.title;
  return dictionary.notifications.system;
}

function formatRelativeTime(locale: Locale, timestamp: string) {
  const created = Date.parse(timestamp);
  if (!Number.isFinite(created)) return "";
  const seconds = Math.max(0, Math.floor((Date.now() - created) / 1000));
  if (seconds < 60) return locale === "ru" ? "только что" : "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return locale === "ru" ? `${minutes} мин.` : `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return locale === "ru" ? `${hours} ч.` : `${hours} h`;
  return new Intl.DateTimeFormat(locale, { dateStyle: "short", timeStyle: "short" }).format(new Date(timestamp));
}

export function NotificationBell({
  dictionary,
  onClick,
  unreadCount
}: {
  dictionary: Dictionary;
  onClick: () => void;
  unreadCount: number;
}) {
  const label =
    unreadCount > 0
      ? dictionary.notifications.unreadLabel.replace("{count}", String(unreadCount))
      : dictionary.notifications.title;
  return (
    <button
      aria-label={label}
      className="notification-bell sidebar-icon-button"
      onClick={onClick}
      title={label}
      type="button"
    >
      <span aria-hidden="true">🔔</span>
      {unreadCount > 0 ? <span className="notification-bell-badge">{formatUnreadCount(unreadCount)}</span> : null}
    </button>
  );
}

export function NotificationCenter({
  dictionary,
  filter,
  hasMore,
  isLoading,
  isOpen,
  items,
  locale,
  onClose,
  onDismiss,
  onFilterChange,
  onLoadMore,
  onMarkAllRead,
  onMarkRead,
  onOpen,
  unreadCount
}: NotificationCenterProps) {
  if (!isOpen) {
    return null;
  }

  return (
    <div className="notification-center-backdrop" role="presentation">
      <aside className="notification-center" aria-label={dictionary.notifications.title}>
        <div className="notification-center-header">
          <div>
            <p className="eyebrow">{dictionary.notifications.eyebrow}</p>
            <h2 className="section-title">{dictionary.notifications.title}</h2>
            <p className="note">{dictionary.notifications.unreadLabel.replace("{count}", String(unreadCount))}</p>
          </div>
          <button className="table-action" onClick={onClose} type="button">
            {dictionary.appShell.close}
          </button>
        </div>
        <div className="notification-center-filters" role="tablist" aria-label={dictionary.notifications.filtersLabel}>
          {filters.map((item) => (
            <button
              aria-selected={filter === item}
              className={filter === item ? "notification-filter notification-filter-active" : "notification-filter"}
              key={item}
              onClick={() => onFilterChange(item)}
              role="tab"
              type="button"
            >
              {dictionary.notifications.filters[item]}
            </button>
          ))}
        </div>
        <div className="notification-center-actions">
          <button className="secondary-link" onClick={onMarkAllRead} type="button">
            {dictionary.notifications.markAllRead}
          </button>
        </div>
        <div className="notification-list">
          {items.length === 0 && !isLoading ? (
            <p className="sidebar-empty-state">{dictionary.notifications.empty}</p>
          ) : null}
          {items.map((notification) => (
            <article
              className={[
                "notification-card",
                notification.is_read ? "" : "notification-card-unread"
              ].filter(Boolean).join(" ")}
              key={notification.id}
            >
              <UserAvatar
                user={{
                  id: notification.actor.id ?? undefined,
                  username: notification.actor.username ?? undefined,
                  display_name: notification.actor.display_name ?? dictionary.notifications.title,
                  avatar_url: notification.actor.avatar_url
                }}
                size={36}
              />
              <div className="notification-card-body">
                <div className="notification-card-top">
                  <strong>{notificationTitle(dictionary, notification)}</strong>
                  <span>{formatRelativeTime(locale, notification.created_at)}</span>
                </div>
                <p>{notification.body_preview || dictionary.notifications.previewHidden}</p>
                <span className="notification-source">{sourceLabel(dictionary, notification)}</span>
                <div className="notification-card-actions">
                  <button className="table-action" onClick={() => onOpen(notification)} type="button">
                    {dictionary.notifications.open}
                  </button>
                  {!notification.is_read ? (
                    <button className="table-action" onClick={() => onMarkRead(notification)} type="button">
                      {dictionary.notifications.markRead}
                    </button>
                  ) : null}
                  <button className="table-action" onClick={() => onDismiss(notification)} type="button">
                    {dictionary.notifications.dismiss}
                  </button>
                </div>
              </div>
            </article>
          ))}
          {isLoading ? <p className="muted">{dictionary.notifications.loading}</p> : null}
          {hasMore ? (
            <button className="secondary-link" onClick={onLoadMore} type="button">
              {dictionary.notifications.loadMore}
            </button>
          ) : null}
        </div>
      </aside>
    </div>
  );
}
