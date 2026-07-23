"use client";

import type { ReactNode } from "react";

import type { Dictionary } from "../lib/i18n";
import { formatUnreadCount } from "../lib/useUnreadStore";

type SidebarConversationRowProps = {
  avatar: ReactNode;
  dictionary: Dictionary;
  disabled?: boolean;
  isCollapsed: boolean;
  isMentioned: boolean;
  isSelected: boolean;
  isUnread: boolean;
  mentionCount: number;
  name: string;
  onClick: () => void;
  preview: string;
  secondary: string;
  timestamp?: string;
  unreadCount: number;
};

export function SidebarConversationRow({
  avatar,
  dictionary,
  disabled = false,
  isCollapsed,
  isMentioned,
  isSelected,
  isUnread,
  mentionCount,
  name,
  onClick,
  preview,
  secondary,
  timestamp,
  unreadCount
}: SidebarConversationRowProps) {
  const itemClassName = [
    "user-app-nav-item",
    isSelected ? "user-app-nav-item-active" : "",
    isUnread ? "user-app-nav-item-unread" : "",
    isMentioned ? "user-app-nav-item-mentioned" : ""
  ].filter(Boolean).join(" ");

  return (
    <button
      aria-label={`${name}, ${secondary}`}
      className={itemClassName}
      disabled={disabled}
      onClick={onClick}
      title={isCollapsed ? name : undefined}
      type="button"
    >
      <span className="sidebar-item-avatar">{avatar}</span>
      <span className="sidebar-item-content">
        <span className="sidebar-item-top">
          <strong>{name}</strong>
        </span>
        <span className="sidebar-item-preview">{preview}</span>
        <span className="sidebar-item-meta">{secondary}</span>
      </span>
      <span className="sidebar-item-right-meta">
        {timestamp ? <span className="sidebar-item-time">{timestamp}</span> : null}
        <span className="sidebar-item-badges">
          {unreadCount > 0 ? (
            <span
              aria-label={dictionary.unread.counterLabel.replace("{count}", String(unreadCount))}
              className="sidebar-unread-badge"
              title={dictionary.unread.counterLabel.replace("{count}", String(unreadCount))}
            >
              {formatUnreadCount(unreadCount)}
            </span>
          ) : null}
          {mentionCount > 0 ? (
            <span
              aria-label={dictionary.unread.mentionLabel.replace("{count}", String(mentionCount))}
              className="sidebar-unread-badge sidebar-unread-badge-mention"
              title={dictionary.unread.mentionLabel.replace("{count}", String(mentionCount))}
            >
              @{formatUnreadCount(mentionCount)}
            </span>
          ) : null}
        </span>
      </span>
    </button>
  );
}
