"use client";

import Link from "next/link";
import { createPortal } from "react-dom";
import {
  type CSSProperties,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState
} from "react";

import { isAdminRole, type OfficeChatUser } from "../lib/api";
import {
  calculateFixedPopoverPosition,
  type FixedPopoverPosition
} from "../lib/fixedPopover";
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
  const [adminMenuPosition, setAdminMenuPosition] =
    useState<FixedPopoverPosition | null>(null);
  const adminMenuRef = useRef<HTMLElement | null>(null);
  const adminMenuButtonRef = useRef<HTMLButtonElement | null>(null);
  const focusFirstItemOnOpenRef = useRef(false);
  const adminMenuId = useId();
  const showAdminMenu = Boolean(currentUser && isAdminRole(currentUser.role));

  function closeAdminMenu({ restoreFocus = false } = {}) {
    setIsAdminMenuOpen(false);
    setAdminMenuPosition(null);
    if (restoreFocus) {
      adminMenuButtonRef.current?.focus();
    }
  }

  function focusAdminMenuItem(position: "first" | "last" | "next" | "previous") {
    const items = Array.from(
      adminMenuRef.current?.querySelectorAll<HTMLElement>(
        '[role="menuitem"]:not([aria-disabled="true"])'
      ) ?? []
    );
    if (items.length === 0) return;
    const currentIndex = items.indexOf(document.activeElement as HTMLElement);
    if (position === "first") {
      items[0].focus();
      return;
    }
    if (position === "last") {
      items[items.length - 1].focus();
      return;
    }
    const offset = position === "next" ? 1 : -1;
    const nextIndex =
      currentIndex < 0
        ? position === "next" ? 0 : items.length - 1
        : (currentIndex + offset + items.length) % items.length;
    items[nextIndex].focus();
  }

  function updateAdminMenuPosition() {
    const button = adminMenuButtonRef.current;
    const menu = adminMenuRef.current;
    if (!button || !menu) return;
    const menuRect = menu.getBoundingClientRect();
    const position = calculateFixedPopoverPosition({
      anchor: button.getBoundingClientRect(),
      menuHeight: Math.max(menuRect.height, menu.scrollHeight, 1),
      menuWidth: Math.max(menuRect.width, menu.offsetWidth, 240),
      viewportHeight: window.innerHeight,
      viewportWidth: window.innerWidth
    });
    setAdminMenuPosition(position);
  }

  useLayoutEffect(() => {
    if (!isAdminMenuOpen) return;
    updateAdminMenuPosition();
    if (focusFirstItemOnOpenRef.current) {
      focusFirstItemOnOpenRef.current = false;
      focusAdminMenuItem("first");
    }
  }, [isAdminMenuOpen]);

  useEffect(() => {
    if (!isAdminMenuOpen) return;
    const closeOnPointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (
        !adminMenuRef.current?.contains(target) &&
        !adminMenuButtonRef.current?.contains(target)
      ) {
        closeAdminMenu();
      }
    };
    const closeOnKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        closeAdminMenu({ restoreFocus: true });
      } else if (event.key === "Tab") {
        closeAdminMenu();
      }
    };
    const closeOnScroll = () => closeAdminMenu();
    const reposition = () => updateAdminMenuPosition();
    const resizeObserver =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(reposition);
    if (adminMenuButtonRef.current) {
      resizeObserver?.observe(adminMenuButtonRef.current);
      const sidebar = adminMenuButtonRef.current.closest(".user-app-sidebar");
      if (sidebar) {
        resizeObserver?.observe(sidebar);
      }
    }
    document.addEventListener("pointerdown", closeOnPointerDown);
    document.addEventListener("keydown", closeOnKeyDown);
    window.addEventListener("resize", reposition);
    window.addEventListener("scroll", closeOnScroll, true);
    return () => {
      document.removeEventListener("pointerdown", closeOnPointerDown);
      document.removeEventListener("keydown", closeOnKeyDown);
      window.removeEventListener("resize", reposition);
      window.removeEventListener("scroll", closeOnScroll, true);
      resizeObserver?.disconnect();
    };
  }, [isAdminMenuOpen]);

  useEffect(() => {
    if (!showAdminMenu && isAdminMenuOpen) {
      closeAdminMenu();
    }
  }, [isAdminMenuOpen, showAdminMenu]);

  function handleAdminButtonKeyDown(event: React.KeyboardEvent<HTMLButtonElement>) {
    if (!["ArrowDown", "Enter", " "].includes(event.key)) return;
    event.preventDefault();
    if (isAdminMenuOpen) {
      focusAdminMenuItem("first");
      return;
    }
    focusFirstItemOnOpenRef.current = true;
    setIsAdminMenuOpen(true);
  }

  function handleAdminMenuKeyDown(event: React.KeyboardEvent<HTMLElement>) {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      closeAdminMenu({ restoreFocus: true });
      return;
    }
    if (event.key === "Tab") {
      closeAdminMenu();
      return;
    }
    const movements = {
      ArrowDown: "next",
      ArrowUp: "previous",
      Home: "first",
      End: "last"
    } as const;
    const movement = movements[event.key as keyof typeof movements];
    if (!movement) return;
    event.preventDefault();
    focusAdminMenuItem(movement);
  }

  const adminMenuStyle: CSSProperties | undefined = adminMenuPosition
    ? {
        left: adminMenuPosition.left,
        maxHeight: adminMenuPosition.maxHeight,
        top: adminMenuPosition.top,
        visibility: "visible",
        width: adminMenuPosition.width
      }
    : { visibility: "hidden" };

  return (
    <footer className="messenger-sidebar-account">
      {currentUser ? (
        <button
          aria-label={dictionary.appShell.profile.open}
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
          <div className="sidebar-admin-menu-wrap">
            <button
              aria-controls={adminMenuId}
              aria-expanded={isAdminMenuOpen}
              aria-haspopup="menu"
              aria-label={dictionary.appShell.adminMenu}
              className="sidebar-icon-button"
              onClick={() => {
                focusFirstItemOnOpenRef.current = false;
                if (isAdminMenuOpen) {
                  closeAdminMenu();
                } else {
                  setIsAdminMenuOpen(true);
                }
              }}
              onKeyDown={handleAdminButtonKeyDown}
              ref={adminMenuButtonRef}
              title={dictionary.appShell.adminMenu}
              type="button"
            >
              <span aria-hidden="true">...</span>
            </button>
            {isAdminMenuOpen && typeof document !== "undefined" ? createPortal(
              <nav
                aria-label={dictionary.appShell.adminMenu}
                className="sidebar-admin-menu"
                data-placement={adminMenuPosition?.placement}
                id={adminMenuId}
                onKeyDown={handleAdminMenuKeyDown}
                ref={adminMenuRef}
                role="menu"
                style={adminMenuStyle}
              >
                <Link href={`/${locale}/admin/users`} onClick={() => closeAdminMenu()} role="menuitem">
                  {dictionary.adminUsers.title}
                </Link>
                <Link href={`/${locale}/groups`} onClick={() => closeAdminMenu()} role="menuitem">
                  {dictionary.groups.title}
                </Link>
                <Link href={`/${locale}/admin/bots`} onClick={() => closeAdminMenu()} role="menuitem">
                  {dictionary.adminBots.title}
                </Link>
                <Link href={`/${locale}/admin/storage`} onClick={() => closeAdminMenu()} role="menuitem">
                  {dictionary.retention.title}
                </Link>
                <Link href={`/${locale}/admin/audit`} onClick={() => closeAdminMenu()} role="menuitem">
                  {dictionary.audit.title}
                </Link>
              </nav>,
              document.body
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
    </footer>
  );
}
