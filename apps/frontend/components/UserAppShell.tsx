"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";

import {
  clearStoredAccessToken,
  createDirectConversation,
  getCurrentUser,
  getDirectConversations,
  getDirectWebSocketUrl,
  getGroups,
  getGroupMembers,
  getGroupMessages,
  getGroupWebSocketUrl,
  getStoredAccessToken,
  getUsers,
  isAdminRole,
  type DirectMessageEvent,
  type GroupMessageEvent,
  type OfficeChatDirectoryUser,
  type OfficeChatDirectConversation,
  type OfficeChatDirectMessage,
  type OfficeChatGroup,
  type OfficeChatGroupMember,
  type OfficeChatMessage,
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

type SidebarActivityItem = {
  preview: string;
  timestamp: string;
  unread: boolean;
};

type SidebarActivityState = {
  groups: Record<string, SidebarActivityItem>;
  directUsers: Record<string, SidebarActivityItem>;
};

const settingsKey = "officechat.user_settings";
const sidebarActivityKeyPrefix = "officechat.sidebar_activity";
const defaultSettings: AppSettings = {
  accentColor: "default",
  fontSize: "normal",
  language: "ru",
  sidebarSide: "left"
};

const emptySidebarActivity: SidebarActivityState = {
  groups: {},
  directUsers: {}
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

function readSidebarActivity(userId: string): SidebarActivityState {
  if (typeof window === "undefined") {
    return emptySidebarActivity;
  }

  try {
    const saved = localStorage.getItem(`${sidebarActivityKeyPrefix}.${userId}`);
    if (!saved) {
      return emptySidebarActivity;
    }
    const parsed = JSON.parse(saved) as Partial<SidebarActivityState>;
    return {
      groups: parsed.groups ?? {},
      directUsers: parsed.directUsers ?? {}
    };
  } catch {
    return emptySidebarActivity;
  }
}

function getActivityTime(activity?: SidebarActivityItem) {
  return activity?.timestamp ? Date.parse(activity.timestamp) || 0 : 0;
}

export function UserAppShell({ dictionary, locale }: UserAppShellProps) {
  const router = useRouter();
  const [currentUser, setCurrentUser] = useState<OfficeChatUser | null>(null);
  const [groups, setGroups] = useState<OfficeChatGroup[]>([]);
  const [users, setUsers] = useState<OfficeChatDirectoryUser[]>([]);
  const [directConversations, setDirectConversations] = useState<OfficeChatDirectConversation[]>([]);
  const [selected, setSelected] = useState<AppSelection>({ type: "empty" });
  const [selectedMembers, setSelectedMembers] = useState<OfficeChatGroupMember[]>([]);
  const [sidebarActivity, setSidebarActivity] = useState<SidebarActivityState>(emptySidebarActivity);
  const [settings, setSettings] = useState<AppSettings>(() => ({ ...defaultSettings, language: locale }));
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [pendingDirectUsername, setPendingDirectUsername] = useState<string | null>(null);
  const [error, setError] = useState("");

  const selectedGroup = selected.type === "group" ? groups.find((group) => group.id === selected.groupId) : null;
  const selectedDirectConversation =
    selected.type === "direct"
      ? directConversations.find((conversation) => conversation.id === selected.conversationId)
      : null;
  const directMessageUsers = currentUser
    ? users.filter((user) => user.id !== currentUser.id && user.role !== "bot" && user.is_active)
    : [];
  const orderedGroups = useMemo(
    () =>
      groups
        .map((group, index) => ({ group, index }))
        .sort((left, right) => {
          const timeDifference =
            getActivityTime(sidebarActivity.groups[right.group.id]) -
            getActivityTime(sidebarActivity.groups[left.group.id]);
          return timeDifference || left.index - right.index;
        })
        .map(({ group }) => group),
    [groups, sidebarActivity.groups]
  );
  const orderedDirectMessageUsers = useMemo(
    () =>
      directMessageUsers
        .map((user, index) => ({ user, index }))
        .sort((left, right) => {
          const timeDifference =
            getActivityTime(sidebarActivity.directUsers[right.user.id]) -
            getActivityTime(sidebarActivity.directUsers[left.user.id]);
          return timeDifference || left.index - right.index;
        })
        .map(({ user }) => user),
    [directMessageUsers, sidebarActivity.directUsers]
  );
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

  const shortTimeFormatter = useMemo(
    () =>
      new Intl.DateTimeFormat(locale, {
        hour: "2-digit",
        minute: "2-digit"
      }),
    [locale]
  );

  function formatActivityTime(timestamp?: string) {
    if (!timestamp) {
      return "";
    }
    return shortTimeFormatter.format(new Date(timestamp));
  }

  function getGroupMessagePreview(message: OfficeChatMessage) {
    if (message.is_deleted) {
      return dictionary.messages.deletedMessage;
    }
    const body = message.body.trim();
    if (body) {
      return body;
    }
    if (message.attachments.length > 0) {
      return dictionary.sidebarActivity.attachment;
    }
    return dictionary.sidebarActivity.noRecentMessages;
  }

  function getDirectMessagePreview(message: OfficeChatDirectMessage) {
    if (message.is_deleted) {
      return dictionary.messages.deletedMessage;
    }
    return message.body.trim() || dictionary.sidebarActivity.noRecentMessages;
  }

  const updateGroupActivity = useCallback(
    (groupId: string, message: OfficeChatMessage, markUnread: boolean) => {
      const nextActivity = {
        preview: getGroupMessagePreview(message),
        timestamp: message.updated_at ?? message.created_at,
        unread: markUnread
      };
      setSidebarActivity((currentActivity) => ({
        ...currentActivity,
        groups: {
          ...currentActivity.groups,
          [groupId]: {
            ...currentActivity.groups[groupId],
            ...nextActivity,
            unread: markUnread || currentActivity.groups[groupId]?.unread || false
          }
        }
      }));
    },
    [dictionary.messages.deletedMessage, dictionary.sidebarActivity.attachment, dictionary.sidebarActivity.noRecentMessages]
  );

  const updateDirectUserActivity = useCallback(
    (userId: string, message: OfficeChatDirectMessage, markUnread: boolean) => {
      const nextActivity = {
        preview: getDirectMessagePreview(message),
        timestamp: message.updated_at ?? message.created_at,
        unread: markUnread
      };
      setSidebarActivity((currentActivity) => ({
        ...currentActivity,
        directUsers: {
          ...currentActivity.directUsers,
          [userId]: {
            ...currentActivity.directUsers[userId],
            ...nextActivity,
            unread: markUnread || currentActivity.directUsers[userId]?.unread || false
          }
        }
      }));
    },
    [dictionary.messages.deletedMessage, dictionary.sidebarActivity.noRecentMessages]
  );

  function markGroupRead(groupId: string) {
    setSidebarActivity((currentActivity) => ({
      ...currentActivity,
      groups: {
        ...currentActivity.groups,
        [groupId]: {
          ...(currentActivity.groups[groupId] ?? {
            preview: dictionary.sidebarActivity.noRecentMessages,
            timestamp: "",
            unread: false
          }),
          unread: false
        }
      }
    }));
  }

  function markDirectUserRead(userId: string) {
    setSidebarActivity((currentActivity) => ({
      ...currentActivity,
      directUsers: {
        ...currentActivity.directUsers,
        [userId]: {
          ...(currentActivity.directUsers[userId] ?? {
            preview: dictionary.sidebarActivity.noRecentMessages,
            timestamp: "",
            unread: false
          }),
          unread: false
        }
      }
    }));
  }

  useEffect(() => {
    const loadedSettings = readSettings(locale);
    setSettings({ ...loadedSettings, language: locale });
  }, [locale]);

  useEffect(() => {
    if (!currentUser) {
      return;
    }

    // TODO: Replace localStorage sidebar activity with backend read receipts and server-side unread counters.
    localStorage.setItem(`${sidebarActivityKeyPrefix}.${currentUser.id}`, JSON.stringify(sidebarActivity));
  }, [currentUser, sidebarActivity]);

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
        setSidebarActivity(readSidebarActivity(loadedUser.id));
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

  useEffect(() => {
    if (selected.type === "group") {
      markGroupRead(selected.groupId);
      return;
    }

    if (selectedDirectConversation) {
      markDirectUserRead(selectedDirectConversation.other_user.id);
    }
  }, [selected, selectedDirectConversation]);

  useEffect(() => {
    if (!currentUser || groups.length === 0) {
      return;
    }

    const token = getStoredAccessToken();
    if (!token) {
      return;
    }

    let isCancelled = false;
    for (const group of groups) {
      void getGroupMessages(token, group.id, 1)
        .then((messages) => {
          if (!isCancelled && messages[0]) {
            updateGroupActivity(group.id, messages[0], false);
          }
        })
        .catch(() => undefined);
    }

    return () => {
      isCancelled = true;
    };
  }, [currentUser, groups, updateGroupActivity]);

  useEffect(() => {
    if (!currentUser) {
      return;
    }

    for (const conversation of directConversations) {
      if (conversation.last_message) {
        updateDirectUserActivity(conversation.other_user.id, conversation.last_message, false);
      }
    }
  }, [currentUser, directConversations, updateDirectUserActivity]);

  useEffect(() => {
    if (!currentUser || groups.length === 0) {
      return;
    }

    const token = getStoredAccessToken();
    if (!token) {
      return;
    }

    const sockets = groups.map((group) => {
      const websocket = new WebSocket(getGroupWebSocketUrl(token, group.id));
      websocket.onmessage = (event) => {
        try {
          const payload = JSON.parse(event.data as string) as GroupMessageEvent;
          if (!payload.type.startsWith("message.")) {
            return;
          }
          const isSelectedGroup = selected.type === "group" && selected.groupId === payload.group_id;
          const isOwnMessage = payload.message.sender_user_id === currentUser.id;
          updateGroupActivity(payload.group_id, payload.message, !isSelectedGroup && !isOwnMessage);
        } catch {
          return;
        }
      };
      return websocket;
    });

    return () => {
      for (const socket of sockets) {
        socket.close();
      }
    };
  }, [currentUser, groups, selected, updateGroupActivity]);

  useEffect(() => {
    if (!currentUser || directConversations.length === 0) {
      return;
    }

    const token = getStoredAccessToken();
    if (!token) {
      return;
    }

    const sockets = directConversations.map((conversation) => {
      const websocket = new WebSocket(getDirectWebSocketUrl(token, conversation.id));
      websocket.onmessage = (event) => {
        try {
          const payload = JSON.parse(event.data as string) as DirectMessageEvent;
          if (!payload.type.startsWith("direct.message.")) {
            return;
          }
          const isSelectedConversation =
            selected.type === "direct" && selected.conversationId === payload.conversation_id;
          const isOwnMessage = payload.message.sender_user_id === currentUser.id;
          updateDirectUserActivity(conversation.other_user.id, payload.message, !isSelectedConversation && !isOwnMessage);
        } catch {
          return;
        }
      };
      return websocket;
    });

    return () => {
      for (const socket of sockets) {
        socket.close();
      }
    };
  }, [currentUser, directConversations, selected, updateDirectUserActivity]);

  useEffect(() => {
    if (!currentUser) {
      return;
    }
    const currentUserId = currentUser.id;

    const token = getStoredAccessToken();
    if (!token) {
      return;
    }
    const accessToken = token;

    async function refreshDirectConversations() {
      try {
        const loadedConversations = await getDirectConversations(accessToken);
        setDirectConversations(loadedConversations);
        setSidebarActivity((currentActivity) => {
          const nextDirectUsers = { ...currentActivity.directUsers };
          for (const conversation of loadedConversations) {
            const lastMessage = conversation.last_message;
            if (!lastMessage) {
              continue;
            }
            const existingActivity = nextDirectUsers[conversation.other_user.id];
            const lastMessageTime = Date.parse(lastMessage.updated_at ?? lastMessage.created_at) || 0;
            const existingTime = getActivityTime(existingActivity);
            const isSelectedConversation =
              selected.type === "direct" && selected.conversationId === conversation.id;
            const shouldMarkUnread =
              lastMessageTime > existingTime &&
              !isSelectedConversation &&
              lastMessage.sender_user_id !== currentUserId;
            nextDirectUsers[conversation.other_user.id] = {
              ...existingActivity,
              preview: getDirectMessagePreview(lastMessage),
              timestamp: lastMessage.updated_at ?? lastMessage.created_at,
              unread: shouldMarkUnread || existingActivity?.unread || false
            };
          }
          return {
            ...currentActivity,
            directUsers: nextDirectUsers
          };
        });
      } catch {
        return;
      }
    }

    const timer = setInterval(() => void refreshDirectConversations(), 20000);
    return () => clearInterval(timer);
  }, [currentUser, selected, dictionary.messages.deletedMessage, dictionary.sidebarActivity.noRecentMessages]);

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
    if (pendingDirectUsername === user.username) {
      return;
    }

    const token = getStoredAccessToken();
    if (!token) {
      router.replace(`/${locale}/login`);
      return;
    }

    setError("");
    setPendingDirectUsername(user.username);
    const abortController = new AbortController();
    const timeout = setTimeout(() => abortController.abort(), 15000);
    try {
      const conversation = await createDirectConversation(token, user.username, abortController.signal);
      setDirectConversations((currentConversations) => {
        const existingConversation = currentConversations.some((item) => item.id === conversation.id);
        if (!existingConversation) {
          return [conversation, ...currentConversations];
        }
        return currentConversations.map((item) => (item.id === conversation.id ? conversation : item));
      });
      setSelected({ type: "direct", conversationId: conversation.id });
    } catch (caughtError) {
      setError(caughtError instanceof Error && caughtError.name !== "AbortError" ? caughtError.message : dictionary.appShell.loadError);
    } finally {
      clearTimeout(timeout);
      setPendingDirectUsername(null);
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
              {orderedGroups.map((group) => {
                const activity = sidebarActivity.groups[group.id];
                const isSelected = selected.type === "group" && selected.groupId === group.id;
                const itemClassName = [
                  "user-app-nav-item",
                  isSelected ? "user-app-nav-item-active" : "",
                  activity?.unread ? "user-app-nav-item-unread" : ""
                ]
                  .filter(Boolean)
                  .join(" ");
                return (
                  <button
                    className={itemClassName}
                    key={group.id}
                    onClick={() => {
                      setSelected({ type: "group", groupId: group.id });
                      markGroupRead(group.id);
                    }}
                    type="button"
                  >
                    {activity?.unread ? (
                      <span
                        aria-label={dictionary.sidebarActivity.unread}
                        className="sidebar-unread-dot"
                        title={dictionary.sidebarActivity.newMessages}
                      />
                    ) : null}
                    <span className="sidebar-item-top">
                      <strong>{group.name}</strong>
                      {activity?.timestamp ? (
                        <span className="sidebar-item-time">{formatActivityTime(activity.timestamp)}</span>
                      ) : null}
                    </span>
                    <span className="sidebar-item-meta">{group.slug}</span>
                    <span className="sidebar-item-preview">
                      {activity?.preview || dictionary.sidebarActivity.noRecentMessages}
                    </span>
                  </button>
                );
              })}
              {!isLoading && groups.length === 0 ? (
                <p className="muted">{dictionary.appShell.noGroups}</p>
              ) : null}
            </div>
          </section>

          <section>
            <h2 className="compact-title">{dictionary.appShell.users}</h2>
            <div className="user-app-nav-list">
              {orderedDirectMessageUsers.map((user) => {
                const activity = sidebarActivity.directUsers[user.id];
                const isSelected =
                  selected.type === "direct" && selectedDirectConversation?.other_user.id === user.id;
                const itemClassName = [
                  "user-app-nav-item",
                  isSelected ? "user-app-nav-item-active" : "",
                  activity?.unread ? "user-app-nav-item-unread" : ""
                ]
                  .filter(Boolean)
                  .join(" ");
                return (
                  <button
                    className={itemClassName}
                    disabled={pendingDirectUsername === user.username}
                    key={user.id}
                    onClick={() => void handleOpenDirectUser(user)}
                    type="button"
                  >
                    {activity?.unread ? (
                      <span
                        aria-label={dictionary.sidebarActivity.unread}
                        className="sidebar-unread-dot"
                        title={dictionary.sidebarActivity.newMessages}
                      />
                    ) : null}
                    <strong>{user.display_name}</strong>
                    {activity?.timestamp ? (
                      <span className="sidebar-item-time">{formatActivityTime(activity.timestamp)}</span>
                    ) : null}
                    <span className="sidebar-item-preview">
                      {activity?.preview || dictionary.sidebarActivity.noRecentMessages}
                    </span>
                    <span className="sidebar-item-meta">
                      @{user.username} - {user.role}
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
