"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";

import { isAdminRole, type OfficeChatUser } from "../lib/api";
import type { Dictionary, Locale } from "../lib/i18n";
import { NotificationBell } from "./NotificationCenter";
import { UserAvatar } from "./UserAvatar";

type SidebarAccountFooterProps = {
  currentUser: OfficeChatUser | null;
  dictionary: Dictionary;
  locale: Locale;
  notificationUnreadCount: number;
  onLogout: () => void;
  onOpenNotifications: () => void;
  onOpenProfile: () => void;
  onOpenSettings: () => void;
};

export function SidebarAccountFooter({
  currentUser,
  dictionary,
  locale,
  notificationUnreadCount,
  onLogout,
  onOpenNotifications,
  onOpenProfile,
  onOpenSettings
}: SidebarAccountFooterProps) {
  const [isAdminMenuOpen, setIsAdminMenuOpen] = useState(false);
  const adminMenuRef = useRef<HTMLDivElement | null>(null);
  const adminMenuButtonRef = useRef<HTMLButtonElement | null>(null);
  const showAdminMenu = Boolean(currentUser && isAdminRole(currentUser.role));

  useEffect(() => {
    if (!isAdminMenuOpen) return;
    const closeOnPointerDown = (event: PointerEvent) => {
      if (!adminMenuRef.current?.contains(event.target as Node)) {
        setIsAdminMenuOpen(false);
      }
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setIsAdminMenuOpen(false);
      adminMenuButtonRef.current?.focus();
    };
    document.addEventListener("pointerdown", closeOnPointerDown);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOnPointerDown);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [isAdminMenuOpen]);

  return (
    <div className="messenger-sidebar-account">
      {currentUser ? (
        <button
          className="sidebar-account-button"
          onClick={onOpenProfile}
          title={dictionary.appShell.profile.open}
          type="button"
        >
          <UserAvatar user={currentUser} size={40} />
          <span className="sidebar-item-content">
            <strong>{currentUser.display_name}</strong>
            <small>@{currentUser.username}</small>
          </span>
        </button>
      ) : null}
      <div className="sidebar-account-actions">
        <NotificationBell
          dictionary={dictionary}
          onClick={onOpenNotifications}
          unreadCount={notificationUnreadCount}
        />
        <button
          aria-label={dictionary.appShell.settings}
          className="sidebar-icon-button"
          onClick={onOpenSettings}
          title={dictionary.appShell.settings}
          type="button"
        >
          <span aria-hidden="true">⚙</span>
        </button>
        {showAdminMenu ? (
          <div className="sidebar-admin-menu-wrap" ref={adminMenuRef}>
            <button
              aria-expanded={isAdminMenuOpen}
              aria-haspopup="menu"
              aria-label={dictionary.appShell.adminMenu}
              className="sidebar-icon-button"
              onClick={() => setIsAdminMenuOpen((current) => !current)}
              ref={adminMenuButtonRef}
              title={dictionary.appShell.adminMenu}
              type="button"
            >
              <span aria-hidden="true">...</span>
            </button>
            {isAdminMenuOpen ? (
              <nav
                aria-label={dictionary.appShell.adminMenu}
                className="sidebar-admin-menu"
                role="menu"
              >
                <Link href={`/${locale}/admin/users`} onClick={() => setIsAdminMenuOpen(false)} role="menuitem">
                  {dictionary.adminUsers.title}
                </Link>
                <Link href={`/${locale}/groups`} onClick={() => setIsAdminMenuOpen(false)} role="menuitem">
                  {dictionary.groups.title}
                </Link>
                <Link href={`/${locale}/admin/bots`} onClick={() => setIsAdminMenuOpen(false)} role="menuitem">
                  {dictionary.adminBots.title}
                </Link>
                <Link href={`/${locale}/admin/storage`} onClick={() => setIsAdminMenuOpen(false)} role="menuitem">
                  {dictionary.retention.title}
                </Link>
                <Link href={`/${locale}/admin/audit`} onClick={() => setIsAdminMenuOpen(false)} role="menuitem">
                  {dictionary.audit.title}
                </Link>
              </nav>
            ) : null}
          </div>
        ) : null}
        <button
          aria-label={dictionary.dashboard.logout}
          className="sidebar-icon-button"
          onClick={onLogout}
          title={dictionary.dashboard.logout}
          type="button"
        >
          <span aria-hidden="true">↪</span>
        </button>
      </div>
    </div>
  );
}
