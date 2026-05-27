"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";

import {
  clearStoredAccessToken,
  createDirectConversation,
  getCurrentUser,
  getDirectConversations,
  getGroups,
  getGroupMembers,
  getStoredAccessToken,
  getUsers,
  isAdminRole,
  type OfficeChatDirectoryUser,
  type OfficeChatDirectConversation,
  type OfficeChatGroup,
  type OfficeChatGroupMember,
  type OfficeChatUser
} from "../lib/api";
import type { Dictionary, Locale } from "../lib/i18n";
import { DirectChatPanel } from "./DirectChatPanel";
import { GroupChatPanel } from "./GroupChatPanel";

type UserAppShellProps = {
  dictionary: Dictionary;
  locale: Locale;
};

type SidebarSide = "left" | "right";
type AppFontSize = "small" | "normal" | "large";
type AccentColor = "default" | "blue" | "green" | "purple";
type AppSelection =
  | { type: "group"; groupId: string }
  | { type: "direct"; conversationId: string }
  | { type: "empty" };

type AppSettings = {
  accentColor: AccentColor;
  fontSize: AppFontSize;
  language: Locale;
  sidebarSide: SidebarSide;
};

const settingsKey = "officechat.user_settings";
const defaultSettings: AppSettings = {
  accentColor: "default",
  fontSize: "normal",
  language: "ru",
  sidebarSide: "left"
};

function readSettings(locale: Locale): AppSettings {
  if (typeof window === "undefined") {
    return { ...defaultSettings, language: locale };
  }

  try {
    const saved = localStorage.getItem(settingsKey);
    if (!saved) {
      return { ...defaultSettings, language: locale };
    }
    const parsed = JSON.parse(saved) as Partial<AppSettings>;
    return {
      accentColor: parsed.accentColor ?? "default",
      fontSize: parsed.fontSize ?? "normal",
      language: parsed.language ?? locale,
      sidebarSide: parsed.sidebarSide ?? "left"
    };
  } catch {
    return { ...defaultSettings, language: locale };
  }
}

export function UserAppShell({ dictionary, locale }: UserAppShellProps) {
  const router = useRouter();
  const [currentUser, setCurrentUser] = useState<OfficeChatUser | null>(null);
  const [groups, setGroups] = useState<OfficeChatGroup[]>([]);
  const [users, setUsers] = useState<OfficeChatDirectoryUser[]>([]);
  const [directConversations, setDirectConversations] = useState<OfficeChatDirectConversation[]>([]);
  const [selected, setSelected] = useState<AppSelection>({ type: "empty" });
  const [selectedMembers, setSelectedMembers] = useState<OfficeChatGroupMember[]>([]);
  const [settings, setSettings] = useState<AppSettings>(() => ({ ...defaultSettings, language: locale }));
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState("");

  const selectedGroup = selected.type === "group" ? groups.find((group) => group.id === selected.groupId) : null;
  const selectedDirectConversation =
    selected.type === "direct"
      ? directConversations.find((conversation) => conversation.id === selected.conversationId)
      : null;
  const directMessageUsers = currentUser
    ? users.filter((user) => user.id !== currentUser.id && user.role !== "bot" && user.is_active)
    : [];
  const currentMembership = currentUser
    ? selectedMembers.find((member) => member.user_id === currentUser.id)
    : undefined;
  const canModerateMessages = Boolean(
    currentUser &&
      selected.type === "group" &&
      (isAdminRole(currentUser.role) ||
        currentMembership?.role === "owner" ||
        currentMembership?.role === "moderator")
  );

  const appShellClass = useMemo(
    () =>
      [
        "user-app-shell",
        settings.sidebarSide === "right" ? "user-app-shell-sidebar-right" : "",
        `user-app-font-${settings.fontSize}`,
        `user-app-accent-${settings.accentColor}`
      ]
        .filter(Boolean)
        .join(" "),
    [settings]
  );

  useEffect(() => {
    const loadedSettings = readSettings(locale);
    setSettings({ ...loadedSettings, language: locale });
  }, [locale]);

  useEffect(() => {
    const token = getStoredAccessToken();
    if (!token) {
      router.replace(`/${locale}/login`);
      return;
    }
    const accessToken = token;

    async function loadApp() {
      try {
        const [loadedUser, loadedGroups, loadedUsers, loadedDirectConversations] = await Promise.all([
          getCurrentUser(accessToken),
          getGroups(accessToken),
          getUsers(accessToken),
          getDirectConversations(accessToken)
        ]);
        setCurrentUser(loadedUser);
        setGroups(loadedGroups);
        setUsers(loadedUsers);
        setDirectConversations(loadedDirectConversations);
        setSelected(loadedGroups[0] ? { type: "group", groupId: loadedGroups[0].id } : { type: "empty" });
      } catch (caughtError) {
        setError(caughtError instanceof Error ? caughtError.message : dictionary.appShell.loadError);
      } finally {
        setIsLoading(false);
      }
    }

    void loadApp();
  }, [dictionary.appShell.loadError, locale, router]);

  useEffect(() => {
    if (selected.type !== "group") {
      setSelectedMembers([]);
      return;
    }

    const token = getStoredAccessToken();
    if (!token) {
      router.replace(`/${locale}/login`);
      return;
    }

    void getGroupMembers(token, selected.groupId)
      .then(setSelectedMembers)
      .catch(() => setSelectedMembers([]));
  }, [locale, router, selected]);

  function updateSettings(nextSettings: AppSettings) {
    setSettings(nextSettings);
    // TODO: Persist app settings in backend user_preferences instead of localStorage.
    localStorage.setItem(settingsKey, JSON.stringify(nextSettings));
  }

  function handleLanguageChange(nextLocale: Locale) {
    updateSettings({ ...settings, language: nextLocale });
    router.push(`/${nextLocale}/app`);
  }

  async function logout() {
    const token = getStoredAccessToken();
    if (token) {
      await fetch(`${process.env.NEXT_PUBLIC_BACKEND_URL}/api/auth/logout`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`
        }
      }).catch(() => undefined);
    }

    clearStoredAccessToken();
    router.replace(`/${locale}/login`);
  }

  async function handleOpenDirectUser(user: OfficeChatDirectoryUser) {
    const token = getStoredAccessToken();
    if (!token) {
      router.replace(`/${locale}/login`);
      return;
    }

    setError("");
    try {
      const conversation = await createDirectConversation(token, user.username);
      setDirectConversations((currentConversations) => {
        const existingConversation = currentConversations.some((item) => item.id === conversation.id);
        if (!existingConversation) {
          return [conversation, ...currentConversations];
        }
        return currentConversations.map((item) => (item.id === conversation.id ? conversation : item));
      });
      setSelected({ type: "direct", conversationId: conversation.id });
    } catch (caughtError) {
      setError(caughtError instanceof Error ? caughtError.message : dictionary.appShell.loadError);
    }
  }

  return (
    <main className={appShellClass}>
      <header className="user-app-topbar">
        <div>
          <p className="eyebrow">{dictionary.app.name}</p>
          <h1 className="user-app-title">{dictionary.appShell.title}</h1>
        </div>
        <div className="user-app-topbar-actions">
          {currentUser ? (
            <div className="user-app-current-user">
              <strong>{currentUser.display_name}</strong>
              <span>@{currentUser.username}</span>
            </div>
          ) : null}
          {currentUser && isAdminRole(currentUser.role) ? (
            <Link className="secondary-link" href={`/${locale}/admin/users`}>
              {dictionary.appShell.admin}
            </Link>
          ) : null}
          <button className="secondary-link" onClick={() => setIsSettingsOpen(true)} type="button">
            {dictionary.appShell.settings}
          </button>
          <button className="secondary-link" onClick={logout} type="button">
            {dictionary.dashboard.logout}
          </button>
        </div>
      </header>

      <div className="user-app-layout">
        <aside className="user-app-sidebar" aria-label={dictionary.appShell.sidebarAriaLabel}>
          <section>
            <h2 className="compact-title">{dictionary.appShell.groups}</h2>
            <div className="user-app-nav-list">
              {groups.map((group) => (
                <button
                  className={
                    selected.type === "group" && selected.groupId === group.id
                      ? "user-app-nav-item user-app-nav-item-active"
                      : "user-app-nav-item"
                  }
                  key={group.id}
                  onClick={() => setSelected({ type: "group", groupId: group.id })}
                  type="button"
                >
                  <strong>{group.name}</strong>
                  <span>{group.slug}</span>
                </button>
              ))}
              {!isLoading && groups.length === 0 ? (
                <p className="muted">{dictionary.appShell.noGroups}</p>
              ) : null}
            </div>
          </section>

          <section>
            <h2 className="compact-title">{dictionary.appShell.users}</h2>
            <div className="user-app-nav-list">
              {directMessageUsers.map((user) => {
                const isSelected =
                  selected.type === "direct" && selectedDirectConversation?.other_user.id === user.id;
                return (
                  <button
                    className={isSelected ? "user-app-nav-item user-app-nav-item-active" : "user-app-nav-item"}
                    key={user.id}
                    onClick={() => void handleOpenDirectUser(user)}
                    type="button"
                  >
                    <strong>{user.display_name}</strong>
                    <span>
                      @{user.username} · {user.role}
                    </span>
                  </button>
                );
              })}
            </div>
          </section>
        </aside>

        <section className="user-app-main" aria-label={dictionary.appShell.mainAriaLabel}>
          {error ? <p className="form-error">{error}</p> : null}
          {isLoading ? <p className="muted">{dictionary.appShell.loading}</p> : null}

          {!isLoading && selected.type === "empty" ? (
            <div className="user-app-placeholder">
              <h2>{dictionary.appShell.emptyTitle}</h2>
              <p>{dictionary.appShell.emptyDescription}</p>
            </div>
          ) : null}

          {selectedGroup && currentUser ? (
            <>
              <div className="user-app-chat-heading">
                <div>
                  <h2 className="section-title">{selectedGroup.name}</h2>
                  <p className="admin-current">{selectedGroup.slug}</p>
                </div>
                <Link className="secondary-link" href={`/${locale}/groups/${selectedGroup.id}`}>
                  {dictionary.appShell.groupDetails}
                </Link>
              </div>
              <GroupChatPanel
                canModerateMessages={canModerateMessages}
                currentUser={currentUser}
                dictionary={dictionary}
                groupId={selectedGroup.id}
                locale={locale}
              />
            </>
          ) : null}

          {selectedDirectConversation && currentUser ? (
            <>
              <div className="user-app-chat-heading">
                <div>
                  <h2 className="section-title">{selectedDirectConversation.other_user.display_name}</h2>
                  <p className="admin-current">@{selectedDirectConversation.other_user.username}</p>
                </div>
              </div>
              <DirectChatPanel
                conversation={selectedDirectConversation}
                currentUser={currentUser}
                dictionary={dictionary}
                locale={locale}
              />
            </>
          ) : null}
        </section>
      </div>

      {isSettingsOpen ? (
        <div className="settings-backdrop" role="presentation">
          <section className="settings-panel" aria-label={dictionary.appShell.settingsTitle}>
            <div className="dashboard-header">
              <h2 className="section-title">{dictionary.appShell.settingsTitle}</h2>
              <button className="table-action" onClick={() => setIsSettingsOpen(false)} type="button">
                {dictionary.appShell.close}
              </button>
            </div>
            <div className="admin-form">
              <label className="field">
                <span className="field-label">{dictionary.appShell.language}</span>
                <select
                  className="field-input"
                  onChange={(event) => handleLanguageChange(event.target.value as Locale)}
                  value={locale}
                >
                  <option value="ru">RU</option>
                  <option value="en">EN</option>
                </select>
              </label>
              <label className="field">
                <span className="field-label">{dictionary.appShell.sidebarSide}</span>
                <select
                  className="field-input"
                  onChange={(event) =>
                    updateSettings({ ...settings, sidebarSide: event.target.value as SidebarSide })
                  }
                  value={settings.sidebarSide}
                >
                  <option value="left">{dictionary.appShell.sidebarLeft}</option>
                  <option value="right">{dictionary.appShell.sidebarRight}</option>
                </select>
              </label>
              <label className="field">
                <span className="field-label">{dictionary.appShell.fontSize}</span>
                <select
                  className="field-input"
                  onChange={(event) =>
                    updateSettings({ ...settings, fontSize: event.target.value as AppFontSize })
                  }
                  value={settings.fontSize}
                >
                  <option value="small">{dictionary.appShell.fontSmall}</option>
                  <option value="normal">{dictionary.appShell.fontNormal}</option>
                  <option value="large">{dictionary.appShell.fontLarge}</option>
                </select>
              </label>
              <label className="field">
                <span className="field-label">{dictionary.appShell.accentColor}</span>
                <select
                  className="field-input"
                  onChange={(event) =>
                    updateSettings({ ...settings, accentColor: event.target.value as AccentColor })
                  }
                  value={settings.accentColor}
                >
                  <option value="default">{dictionary.appShell.accentDefault}</option>
                  <option value="blue">{dictionary.appShell.accentBlue}</option>
                  <option value="green">{dictionary.appShell.accentGreen}</option>
                  <option value="purple">{dictionary.appShell.accentPurple}</option>
                </select>
              </label>
              <p className="note">{dictionary.appShell.settingsNote}</p>
            </div>
          </section>
        </div>
      ) : null}
    </main>
  );
}
