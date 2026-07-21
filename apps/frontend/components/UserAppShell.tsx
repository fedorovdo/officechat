"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent
} from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";

import { BrandLogo } from "./Brand";
import { getLocalizedBrand, officeChatBrand } from "../lib/brand";
import {
  createDirectConversation,
  createDiscussion,
  deleteMyAvatar,
  getAnnouncementUnread,
  getCurrentUser,
  getDirectConversations,
  getDiscussion,
  getGroups,
  getGroupMembers,
  getGroupMessages,
  getLocalizedApiError,
  getMessageContext,
  getNotificationPreferences,
  getNotifications,
  getNotificationUnreadCount,
  getPersonalWebSocketUrl,
  getPresence,
  requireStoredAccessToken,
  getStoredAccessToken,
  getUsers,
  dismissNotification,
  isAdminRole,
  markAllNotificationsRead,
  markNotificationRead,
  uploadMyAvatar,
  updateCurrentUser,
  updateNotificationPreferences,
  type OfficeChatDirectoryUser,
  type OfficeChatDirectConversation,
  type OfficeChatDirectMessage,
  type OfficeChatDiscussionMessage,
  type OfficeChatGroup,
  type OfficeChatGroupMember,
  type OfficeChatCalendarEvent,
  type OfficeChatMessage,
  type OfficeChatMessageContext,
  type OfficeChatMessageSearchResult,
  type OfficeChatNotification,
  type OfficeChatPresence,
  type OfficeChatUser,
  type NotificationPreferences,
  type PersonalNotificationEvent
} from "../lib/api";
import type { Dictionary, Locale } from "../lib/i18n";
import { connectResilientWebSocket } from "../lib/resilientWebSocket";
import { formatUnreadCount, useUnreadStore } from "../lib/useUnreadStore";
import { useMessageSearchShortcut } from "../lib/useMessageSearchShortcut";
import { logoutSession, onAuthenticationExpired } from "../lib/session";
import { DirectChatPanel } from "./DirectChatPanel";
import { DiscussionPanel } from "./DiscussionPanel";
import { GroupChatPanel } from "./GroupChatPanel";
import { MessageSearchPanel } from "./MessageSearchPanel";
import { AnnouncementsPanel } from "./AnnouncementsPanel";
import { AnnouncementUnreadBadge } from "./AnnouncementUnreadBadge";
import { CalendarPanel } from "./CalendarPanel";
import { UserAvatar } from "./UserAvatar";
import { PresenceStatus } from "./PresenceStatus";
import {
  NotificationBell,
  NotificationCenter,
  type NotificationCenterFilter
} from "./NotificationCenter";

type UserAppShellProps = {
  dictionary: Dictionary;
  locale: Locale;
};

const presenceHeartbeatSeconds = Number(process.env.NEXT_PUBLIC_PRESENCE_HEARTBEAT_SECONDS ?? 25);
const presenceHeartbeatIntervalMs =
  (Number.isFinite(presenceHeartbeatSeconds) ? Math.max(10, presenceHeartbeatSeconds) : 25) * 1000;

type SidebarSide = "left" | "right";
type AppFontSize = "small" | "normal" | "large";
type AccentColor = "default" | "blue" | "green" | "purple" | "forest";
type SidebarTab = "all" | "groups" | "direct";
type AppSelection =
  | { type: "group"; groupId: string }
  | { type: "direct"; conversationId: string }
  | { type: "announcements" }
  | { type: "calendar" }
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
  mentioned?: boolean;
};

type SidebarActivityState = {
  groups: Record<string, SidebarActivityItem>;
  directUsers: Record<string, SidebarActivityItem>;
};

type BrowserNotificationPermission = NotificationPermission | "unsupported";
type BrowserNotificationResult = "idle" | "sent" | "skipped" | "failed";
type PersonalSocketStatus = "connected" | "disconnected" | "reconnecting";
type BrowserNotificationSkipReason =
  | "none"
  | "senderIsCurrentUser"
  | "notificationsDisabled"
  | "permissionNotGranted"
  | "tabActive"
  | "duplicate"
  | "unsupported"
  | "constructorError";

type BrowserNotificationDebug = {
  eventType: string;
  messageId: string;
  senderUserId: string;
  currentUserId: string;
  selectedChatId: string;
  permission: BrowserNotificationPermission;
  enabledValue: string;
  visibilityState: DocumentVisibilityState | "unknown";
  windowFocused: boolean;
  attempted: boolean;
  result: BrowserNotificationResult;
  skipReason: BrowserNotificationSkipReason;
  error: string;
  timestamp: string;
};

type BrowserNotificationAttempt = {
  eventType: string;
  messageId: string;
  senderUserId: string;
  body: string;
  selectedChatId: string;
  onClick: () => void;
};

const settingsKey = "officechat.user_settings";
const sidebarActivityKeyPrefix = "officechat.sidebar_activity";
const notificationPreferenceKey = "officechat.notifications.enabled";
const sidebarWidthKey = "officechat.sidebar.width";
const sidebarCollapsedKey = "officechat.sidebar.collapsed";
const sidebarTabKey = "officechat.sidebar.tab";
const defaultSidebarWidth = 320;
const minimumSidebarWidth = 240;
const maximumSidebarWidth = 480;
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

function getBrowserNotificationPermission(): BrowserNotificationPermission {
  if (typeof window === "undefined" || !("Notification" in window)) {
    return "unsupported";
  }
  return Notification.permission;
}

function readNotificationPreference() {
  if (typeof window === "undefined") {
    return false;
  }
  return localStorage.getItem(notificationPreferenceKey) === "true";
}

function readNotificationPreferenceRaw() {
  if (typeof window === "undefined") {
    return "false";
  }
  return localStorage.getItem(notificationPreferenceKey) ?? "false";
}

function getCurrentVisibilityState(): DocumentVisibilityState | "unknown" {
  if (typeof document === "undefined") {
    return "unknown";
  }
  return document.visibilityState;
}

function getCurrentWindowFocusState() {
  if (typeof document === "undefined") {
    return false;
  }
  return document.hasFocus();
}

function createEmptyNotificationDebug(): BrowserNotificationDebug {
  return {
    eventType: "-",
    messageId: "-",
    senderUserId: "-",
    currentUserId: "-",
    selectedChatId: "-",
    permission: "default",
    enabledValue: "false",
    visibilityState: "unknown",
    windowFocused: false,
    attempted: false,
    result: "idle",
    skipReason: "none",
    error: "",
    timestamp: "-"
  };
}

function truncateNotificationPreview(preview: string) {
  return preview.length > 120 ? `${preview.slice(0, 117)}...` : preview;
}

export function UserAppShell({ dictionary, locale }: UserAppShellProps) {
  const router = useRouter();
  const localizedBrand = getLocalizedBrand(locale);
  const notifiedMessageIdsRef = useRef<string[]>([]);
  const messageSearchTriggerRef = useRef<HTMLButtonElement | null>(null);
  const deepLinkHandledRef = useRef(false);
  const avatarInputRef = useRef<HTMLInputElement | null>(null);
  const browserNotificationsEnabledRef = useRef(false);
  const notificationPermissionRef = useRef<BrowserNotificationPermission>("default");
  const windowFocusedRef = useRef(false);
  const visibilityStateRef = useRef<DocumentVisibilityState | "unknown">("unknown");
  const selectedRef = useRef<AppSelection>({ type: "empty" });
  const [currentUser, setCurrentUser] = useState<OfficeChatUser | null>(null);
  const [groups, setGroups] = useState<OfficeChatGroup[]>([]);
  const [users, setUsers] = useState<OfficeChatDirectoryUser[]>([]);
  const [directConversations, setDirectConversations] = useState<OfficeChatDirectConversation[]>([]);
  const [selected, setSelected] = useState<AppSelection>({ type: "empty" });
  const [selectedMembers, setSelectedMembers] = useState<OfficeChatGroupMember[]>([]);
  const [sidebarActivity, setSidebarActivity] = useState<SidebarActivityState>(emptySidebarActivity);
  const [settings, setSettings] = useState<AppSettings>(() => ({ ...defaultSettings, language: locale }));
  const [browserNotificationsEnabled, setBrowserNotificationsEnabled] = useState(false);
  const [notificationPermission, setNotificationPermission] =
    useState<BrowserNotificationPermission>("default");
  const [notificationPreferenceRaw, setNotificationPreferenceRaw] = useState("false");
  const [documentVisibilityState, setDocumentVisibilityState] =
    useState<DocumentVisibilityState | "unknown">("unknown");
  const [isWindowFocused, setIsWindowFocused] = useState(false);
  const [testNotificationStatus, setTestNotificationStatus] = useState("");
  const [notificationDebug, setNotificationDebug] = useState<BrowserNotificationDebug>(() =>
    createEmptyNotificationDebug()
  );
  const [notificationItems, setNotificationItems] = useState<OfficeChatNotification[]>([]);
  const [notificationUnreadCount, setNotificationUnreadCount] = useState(0);
  const [notificationCursor, setNotificationCursor] = useState<string | null>(null);
  const [isNotificationCenterOpen, setIsNotificationCenterOpen] = useState(false);
  const [notificationCenterFilter, setNotificationCenterFilter] =
    useState<NotificationCenterFilter>("all");
  const [isNotificationCenterLoading, setIsNotificationCenterLoading] = useState(false);
  const [notificationPreferences, setNotificationPreferences] = useState<NotificationPreferences | null>(null);
  const [personalSocketStatus, setPersonalSocketStatus] = useState<PersonalSocketStatus>("disconnected");
  const [announcementUnreadCount, setAnnouncementUnreadCount] = useState(0);
  const [announcementReloadKey, setAnnouncementReloadKey] = useState(0);
  const [latestCalendarEvent, setLatestCalendarEvent] = useState<OfficeChatCalendarEvent | null>(null);
  const [presenceByUserId, setPresenceByUserId] = useState<Record<string, OfficeChatPresence>>({});
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [isProfileOpen, setIsProfileOpen] = useState(false);
  const [isNotificationGuideOpen, setIsNotificationGuideOpen] = useState(false);
  const [isMessageSearchOpen, setIsMessageSearchOpen] = useState(false);
  const [messageContext, setMessageContext] = useState<OfficeChatMessageContext | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [pendingDirectUsername, setPendingDirectUsername] = useState<string | null>(null);
  const [activeDiscussionId, setActiveDiscussionId] = useState<string | null>(null);
  const [sidebarSearch, setSidebarSearch] = useState("");
  const [profileDisplayName, setProfileDisplayName] = useState("");
  const [profileSuccess, setProfileSuccess] = useState("");
  const [profileError, setProfileError] = useState("");
  const [isProfileSaving, setIsProfileSaving] = useState(false);
  const [selectedAvatarFile, setSelectedAvatarFile] = useState<File | null>(null);
  const [isAvatarUploading, setIsAvatarUploading] = useState(false);
  const [sidebarWidth, setSidebarWidth] = useState(defaultSidebarWidth);
  const [isSidebarCollapsed, setIsSidebarCollapsed] = useState(false);
  const [sidebarTab, setSidebarTab] = useState<SidebarTab>("all");
  const [sidebarPreferencesLoaded, setSidebarPreferencesLoaded] = useState(false);
  const [error, setError] = useState("");
  const unreadToken = currentUser ? getStoredAccessToken() : null;
  const unreadStore = useUnreadStore(unreadToken, currentUser?.id ?? null);
  useMessageSearchShortcut(() => setIsMessageSearchOpen(true));

  const selectedGroup = selected.type === "group" ? groups.find((group) => group.id === selected.groupId) : null;
  const selectedDirectConversation =
    selected.type === "direct"
      ? directConversations.find((conversation) => conversation.id === selected.conversationId)
      : null;
  const currentSearchChat = activeDiscussionId
    ? { chatType: "discussion" as const, chatId: activeDiscussionId, title: dictionary.discussions.title }
    : selectedGroup
      ? { chatType: "group" as const, chatId: selectedGroup.id, title: selectedGroup.name }
      : selectedDirectConversation
        ? {
            chatType: "direct" as const,
            chatId: selectedDirectConversation.id,
            title: selectedDirectConversation.other_user.display_name
          }
        : null;
  const directMessageUsers = useMemo(
    () =>
      currentUser
        ? users.filter((user) => user.id !== currentUser.id && user.role !== "bot" && user.is_active)
        : [],
    [currentUser, users]
  );
  const orderedGroups = useMemo(
    () =>
      groups
        .filter((group) => group.is_active)
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
  const normalizedSidebarSearch = sidebarSearch.trim().toLocaleLowerCase();
  const filteredOrderedGroups = useMemo(
    () =>
      normalizedSidebarSearch
        ? orderedGroups.filter(
            (group) =>
              group.name.toLocaleLowerCase().includes(normalizedSidebarSearch) ||
              group.slug.toLocaleLowerCase().includes(normalizedSidebarSearch)
          )
        : orderedGroups,
    [normalizedSidebarSearch, orderedGroups]
  );
  const filteredOrderedDirectMessageUsers = useMemo(
    () =>
      normalizedSidebarSearch
        ? orderedDirectMessageUsers.filter(
            (user) =>
              user.display_name.toLocaleLowerCase().includes(normalizedSidebarSearch) ||
              user.username.toLocaleLowerCase().includes(normalizedSidebarSearch)
          )
        : orderedDirectMessageUsers,
    [normalizedSidebarSearch, orderedDirectMessageUsers]
  );
  const hasSidebarSearchResults =
    filteredOrderedGroups.length > 0 || filteredOrderedDirectMessageUsers.length > 0;
  const sidebarChatItems = useMemo(() => {
    const groupItems = filteredOrderedGroups.map((group, index) => ({
      kind: "group" as const,
      id: group.id,
      group,
      index,
      activityTime: getActivityTime(sidebarActivity.groups[group.id])
    }));
    const directItems = filteredOrderedDirectMessageUsers.map((user, index) => ({
      kind: "direct" as const,
      id: user.id,
      user,
      index: groupItems.length + index,
      activityTime: getActivityTime(sidebarActivity.directUsers[user.id])
    }));

    if (sidebarTab === "groups") {
      return groupItems;
    }
    if (sidebarTab === "direct") {
      return directItems;
    }
    return [...groupItems, ...directItems].sort(
      (left, right) => right.activityTime - left.activityTime || left.index - right.index
    );
  }, [
    filteredOrderedDirectMessageUsers,
    filteredOrderedGroups,
    sidebarActivity.directUsers,
    sidebarActivity.groups,
    sidebarTab
  ]);
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
        isSidebarCollapsed ? "user-app-sidebar-collapsed" : "",
        selected.type !== "empty" ? "user-app-has-selection" : "",
        `user-app-font-${settings.fontSize}`,
        `user-app-accent-${settings.accentColor}`
      ]
        .filter(Boolean)
        .join(" "),
    [isSidebarCollapsed, selected.type, settings]
  );
  const appShellStyle = {
    "--sidebar-width": `${isSidebarCollapsed ? 72 : sidebarWidth}px`
  } as CSSProperties;

  const shortTimeFormatter = useMemo(
    () =>
      new Intl.DateTimeFormat(locale, {
        hour: "2-digit",
        minute: "2-digit"
      }),
    [locale]
  );
  const profileDateFormatter = useMemo(
    () =>
      new Intl.DateTimeFormat(locale, {
        dateStyle: "medium",
        timeStyle: "short"
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
      if (message.attachments.length > 1) {
        return dictionary.sidebarActivity.attachmentsCount.replace("{count}", String(message.attachments.length));
      }
      return dictionary.sidebarActivity.attachmentWithFilename.replace(
        "{filename}",
        message.attachments[0].original_filename
      );
    }
    return dictionary.sidebarActivity.noRecentMessages;
  }

  function getDirectMessagePreview(message: OfficeChatDirectMessage) {
    if (message.is_deleted) {
      return dictionary.messages.deletedMessage;
    }
    const body = message.body.trim();
    if (body) return body;
    if (message.attachments.length > 0) {
      if (message.attachments.length > 1) {
        return dictionary.sidebarActivity.attachmentsCount.replace("{count}", String(message.attachments.length));
      }
      return dictionary.sidebarActivity.attachmentWithFilename.replace(
        "{filename}",
        message.attachments[0].original_filename
      );
    }
    return dictionary.sidebarActivity.noRecentMessages;
  }

  function getNotificationMessagePreview(message: OfficeChatDirectMessage | OfficeChatDiscussionMessage) {
    const body = message.body.trim();
    if (body) return body;
    if (message.attachments.length > 1) {
      return dictionary.sidebarActivity.attachmentsCount.replace("{count}", String(message.attachments.length));
    }
    if (message.attachments.length === 1) {
      return dictionary.sidebarActivity.attachmentWithFilename.replace(
        "{filename}", message.attachments[0].original_filename
      );
    }
    return dictionary.sidebarActivity.attachment;
  }

  function getSelectedChatDebugId() {
    return getSelectionDebugId(selected);
  }

  function getSelectionDebugId(selection: AppSelection) {
    if (selection.type === "group") {
      return `group:${selection.groupId}`;
    }
    if (selection.type === "direct") {
      return `direct:${selection.conversationId}`;
    }
    if (selection.type === "announcements") {
      return "announcements";
    }
    if (selection.type === "calendar") {
      return "calendar";
    }
    return "empty";
  }

  function recordNotificationDebug(nextDebug: BrowserNotificationDebug) {
    setNotificationDebug(nextDebug);
  }

  function attemptBrowserNotification({
    eventType,
    messageId,
    senderUserId,
    body,
    selectedChatId,
    onClick
  }: BrowserNotificationAttempt) {
    const permission = getBrowserNotificationPermission();
    const enabledValue = readNotificationPreferenceRaw();
    const visibilityState = getCurrentVisibilityState();
    const windowFocused = getCurrentWindowFocusState();
    const baseDebug: BrowserNotificationDebug = {
      eventType,
      messageId,
      senderUserId,
      currentUserId: currentUser?.id ?? "-",
      selectedChatId,
      permission,
      enabledValue,
      visibilityState,
      windowFocused,
      attempted: false,
      result: "skipped",
      skipReason: "none",
      error: "",
      timestamp: new Date().toISOString()
    };

    if (!currentUser || senderUserId === currentUser.id) {
      recordNotificationDebug({ ...baseDebug, skipReason: "senderIsCurrentUser" });
      return;
    }
    if (typeof window === "undefined" || !("Notification" in window)) {
      recordNotificationDebug({ ...baseDebug, skipReason: "unsupported" });
      return;
    }
    if (!browserNotificationsEnabledRef.current || enabledValue !== "true") {
      recordNotificationDebug({ ...baseDebug, skipReason: "notificationsDisabled" });
      return;
    }
    if (permission !== "granted") {
      recordNotificationDebug({ ...baseDebug, skipReason: "permissionNotGranted" });
      return;
    }
    if (visibilityState === "visible" && windowFocused) {
      recordNotificationDebug({ ...baseDebug, skipReason: "tabActive" });
      return;
    }
    if (notifiedMessageIdsRef.current.includes(messageId)) {
      recordNotificationDebug({ ...baseDebug, skipReason: "duplicate" });
      return;
    }

    try {
      const notification = new Notification("OfficeChat", {
        body: truncateNotificationPreview(body)
      });
      notifiedMessageIdsRef.current = [messageId, ...notifiedMessageIdsRef.current].slice(0, 80);
      notification.onclick = () => {
        window.focus();
        onClick();
        notification.close();
      };
      recordNotificationDebug({
        ...baseDebug,
        attempted: true,
        result: "sent",
        skipReason: "none"
      });
    } catch (caughtError) {
      recordNotificationDebug({
        ...baseDebug,
        attempted: true,
        result: "failed",
        skipReason: "constructorError",
        error: caughtError instanceof Error ? caughtError.message : String(caughtError)
      });
    }
  }

  const updateGroupActivity = useCallback(
    (groupId: string, message: OfficeChatMessage, markUnread: boolean, markMentioned = false) => {
      const nextActivity = {
        preview: getGroupMessagePreview(message),
        timestamp: message.updated_at ?? message.created_at,
        unread: markUnread,
        mentioned: markMentioned
      };
      setSidebarActivity((currentActivity) => ({
        ...currentActivity,
        groups: {
          ...currentActivity.groups,
          [groupId]: {
            ...currentActivity.groups[groupId],
            ...nextActivity,
            unread: markUnread || currentActivity.groups[groupId]?.unread || false,
            mentioned: markMentioned || currentActivity.groups[groupId]?.mentioned || false
          }
        }
      }));
    },
    [
      dictionary.messages.deletedMessage,
      dictionary.sidebarActivity.attachmentWithFilename,
      dictionary.sidebarActivity.noRecentMessages
    ]
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
    [
      dictionary.messages.deletedMessage,
      dictionary.sidebarActivity.attachmentWithFilename,
      dictionary.sidebarActivity.noRecentMessages
    ]
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
          unread: false,
          mentioned: false
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

  function notificationQueryForFilter(filter: NotificationCenterFilter) {
    if (filter === "unread") return { unreadOnly: true };
    if (filter === "mentions") return { type: "mention" };
    if (filter === "replies") return { type: "reply" };
    if (filter === "announcements") return { category: "announcements" };
    if (filter === "calendar") return { category: "calendar" };
    if (filter === "system") return { category: "system" };
    return {};
  }

  async function reloadNotifications(filter = notificationCenterFilter) {
    const token = getStoredAccessToken();
    if (!token) return;
    setIsNotificationCenterLoading(true);
    try {
      const [page, unread] = await Promise.all([
        getNotifications(token, { limit: 30, ...notificationQueryForFilter(filter) }),
        getNotificationUnreadCount(token)
      ]);
      setNotificationItems(page.items);
      setNotificationCursor(page.next_cursor);
      setNotificationUnreadCount(unread.unread_count);
    } catch {
      setError(dictionary.notifications.loadError);
    } finally {
      setIsNotificationCenterLoading(false);
    }
  }

  async function loadMoreNotifications() {
    const token = getStoredAccessToken();
    if (!token || !notificationCursor) return;
    setIsNotificationCenterLoading(true);
    try {
      const page = await getNotifications(token, {
        limit: 30,
        cursor: notificationCursor,
        ...notificationQueryForFilter(notificationCenterFilter)
      });
      setNotificationItems((current) => [...current, ...page.items]);
      setNotificationCursor(page.next_cursor);
    } catch {
      setError(dictionary.notifications.loadError);
    } finally {
      setIsNotificationCenterLoading(false);
    }
  }

  function upsertNotification(notification: OfficeChatNotification) {
    setNotificationItems((current) => [
      notification,
      ...current.filter((item) => item.id !== notification.id)
    ]);
  }

  function removeNotification(notificationId: string) {
    setNotificationItems((current) => current.filter((item) => item.id !== notificationId));
  }

  async function markCenterNotificationRead(notification: OfficeChatNotification) {
    const token = getStoredAccessToken();
    if (!token) return;
    try {
      const updated = await markNotificationRead(token, notification.id);
      setNotificationItems((current) => current.map((item) => (item.id === updated.id ? updated : item)));
      setNotificationUnreadCount((count) => Math.max(0, count - (notification.is_read ? 0 : 1)));
    } catch {
      setError(dictionary.notifications.actionError);
    }
  }

  async function dismissCenterNotification(notification: OfficeChatNotification) {
    const token = getStoredAccessToken();
    if (!token) return;
    try {
      await dismissNotification(token, notification.id);
      removeNotification(notification.id);
      setNotificationUnreadCount((count) => Math.max(0, count - (notification.is_read ? 0 : 1)));
    } catch {
      setError(dictionary.notifications.actionError);
    }
  }

  async function markAllCenterNotificationsRead() {
    const token = getStoredAccessToken();
    if (!token) return;
    try {
      const category =
        notificationCenterFilter === "announcements"
          ? "announcements"
          : notificationCenterFilter === "system"
            ? "system"
            : notificationCenterFilter === "calendar"
              ? "calendar"
            : undefined;
      const result = await markAllNotificationsRead(token, category);
      setNotificationItems((current) =>
        current.map((item) => ({ ...item, is_read: true, read_at: item.read_at ?? new Date().toISOString() }))
      );
      setNotificationUnreadCount(result.unread_count);
    } catch {
      setError(dictionary.notifications.actionError);
    }
  }

  async function openCenterNotification(notification: OfficeChatNotification) {
    try {
      if (notification.category === "announcements" && notification.source_id) {
        setSelected({ type: "announcements" });
        setActiveDiscussionId(null);
        setIsNotificationCenterOpen(false);
        await markCenterNotificationRead(notification);
        return;
      }
      if (notification.category === "calendar") {
        setSelected({ type: "calendar" });
        setActiveDiscussionId(null);
        setIsNotificationCenterOpen(false);
        await markCenterNotificationRead(notification);
        return;
      }
      if (notification.chat_type && notification.chat_id && notification.message_id) {
        await openMessageContext(
          notification.chat_type as "group" | "direct" | "discussion",
          notification.chat_id,
          notification.message_id,
          typeof notification.metadata?.source_group_id === "string" ? notification.metadata.source_group_id : undefined
        );
        setIsNotificationCenterOpen(false);
        await markCenterNotificationRead(notification);
      }
    } catch {
      setError(dictionary.messageSearch.jumpError);
    }
  }

  function upsertPersonalDirectConversation(event: Extract<PersonalNotificationEvent, { type: "user.direct.message.created" }>) {
    if (!currentUser) {
      return;
    }

    setDirectConversations((currentConversations) => {
      const nextConversation: OfficeChatDirectConversation = {
        id: event.conversation_id,
        user_one_id: currentUser.id,
        user_two_id: event.other_user.id,
        created_at: event.message.created_at,
        updated_at: event.message.updated_at,
        other_user: event.other_user,
        last_message: event.message
      };
      const existingConversation = currentConversations.find(
        (conversation) => conversation.id === event.conversation_id
      );
      const conversationsWithoutCurrent = currentConversations.filter(
        (conversation) => conversation.id !== event.conversation_id
      );
      return [
        {
          ...nextConversation,
          user_one_id: existingConversation?.user_one_id ?? nextConversation.user_one_id,
          user_two_id: existingConversation?.user_two_id ?? nextConversation.user_two_id,
          created_at: existingConversation?.created_at ?? nextConversation.created_at
        },
        ...conversationsWithoutCurrent
      ];
    });
  }

  async function handleOpenDiscussion(message: OfficeChatMessage) {
    if (!currentUser) {
      return;
    }
    const token = requireStoredAccessToken(locale);
    if (!token) return;
    setError("");
    try {
      const discussion = await createDiscussion(token, message.group_id, message.id);
      clearMessageContext();
      setActiveDiscussionId(discussion.id);
    } catch (caughtError) {
      setError(caughtError instanceof Error ? caughtError.message : dictionary.discussions.openError);
    }
  }

  useEffect(() => {
    selectedRef.current = selected;
  }, [selected]);

  useEffect(() => {
    const loadedSettings = readSettings(locale);
    const loadedNotificationPreference = readNotificationPreference();
    const loadedNotificationPreferenceRaw = readNotificationPreferenceRaw();
    const loadedNotificationPermission = getBrowserNotificationPermission();
    const loadedVisibilityState = getCurrentVisibilityState();
    const loadedWindowFocusState = getCurrentWindowFocusState();
    setSettings({ ...loadedSettings, language: locale });
    browserNotificationsEnabledRef.current = loadedNotificationPreference;
    notificationPermissionRef.current = loadedNotificationPermission;
    visibilityStateRef.current = loadedVisibilityState;
    windowFocusedRef.current = loadedWindowFocusState;
    setBrowserNotificationsEnabled(loadedNotificationPreference);
    setNotificationPreferenceRaw(loadedNotificationPreferenceRaw);
    setNotificationPermission(loadedNotificationPermission);
    setDocumentVisibilityState(loadedVisibilityState);
    setIsWindowFocused(loadedWindowFocusState);
  }, [locale]);

  useEffect(() => {
    const storedWidth = Number(localStorage.getItem(sidebarWidthKey));
    if (Number.isFinite(storedWidth) && storedWidth >= minimumSidebarWidth && storedWidth <= maximumSidebarWidth) {
      setSidebarWidth(storedWidth);
    }
    setIsSidebarCollapsed(localStorage.getItem(sidebarCollapsedKey) === "true");
    const storedTab = localStorage.getItem(sidebarTabKey);
    if (storedTab === "all" || storedTab === "groups" || storedTab === "direct") {
      setSidebarTab(storedTab);
    }
    setSidebarPreferencesLoaded(true);
  }, []);

  useEffect(() => {
    if (!sidebarPreferencesLoaded) {
      return;
    }
    localStorage.setItem(sidebarWidthKey, String(sidebarWidth));
    localStorage.setItem(sidebarCollapsedKey, String(isSidebarCollapsed));
    localStorage.setItem(sidebarTabKey, sidebarTab);
  }, [isSidebarCollapsed, sidebarPreferencesLoaded, sidebarTab, sidebarWidth]);

  useEffect(() => {
    function updateBrowserAttentionState() {
      const nextVisibilityState = getCurrentVisibilityState();
      const nextWindowFocusState = getCurrentWindowFocusState();
      visibilityStateRef.current = nextVisibilityState;
      windowFocusedRef.current = nextWindowFocusState;
      setDocumentVisibilityState(nextVisibilityState);
      setIsWindowFocused(nextWindowFocusState);
    }

    updateBrowserAttentionState();
    window.addEventListener("focus", updateBrowserAttentionState);
    window.addEventListener("blur", updateBrowserAttentionState);
    document.addEventListener("visibilitychange", updateBrowserAttentionState);
    return () => {
      window.removeEventListener("focus", updateBrowserAttentionState);
      window.removeEventListener("blur", updateBrowserAttentionState);
      document.removeEventListener("visibilitychange", updateBrowserAttentionState);
    };
  }, []);

  useEffect(() => {
    if (!currentUser) {
      return;
    }

    // TODO: Replace localStorage sidebar activity with backend read receipts and server-side unread counters.
    localStorage.setItem(`${sidebarActivityKeyPrefix}.${currentUser.id}`, JSON.stringify(sidebarActivity));
  }, [currentUser, sidebarActivity]);

  useEffect(() => {
    const token = requireStoredAccessToken(locale);
    if (!token) return;
    const accessToken = token;

    async function loadApp() {
      try {
        const [
          loadedUser,
          loadedGroups,
          loadedUsers,
          loadedDirectConversations,
          loadedAnnouncementUnread,
          loadedNotificationUnread,
          loadedNotificationPreferences,
          loadedNotifications
        ] = await Promise.all([
          getCurrentUser(accessToken),
          getGroups(accessToken),
          getUsers(accessToken),
          getDirectConversations(accessToken),
          getAnnouncementUnread(accessToken).catch(() => ({ unread_count: 0 })),
          getNotificationUnreadCount(accessToken).catch(() => ({ unread_count: 0 })),
          getNotificationPreferences(accessToken).catch(() => null),
          getNotifications(accessToken, { limit: 30 }).catch(() => ({ items: [], next_cursor: null }))
        ]);
        setCurrentUser(loadedUser);
        setGroups(loadedGroups);
        setUsers(loadedUsers);
        setDirectConversations(loadedDirectConversations);
        setAnnouncementUnreadCount(loadedAnnouncementUnread.unread_count);
        setNotificationUnreadCount(loadedNotificationUnread.unread_count);
        setNotificationPreferences(loadedNotificationPreferences);
        setNotificationItems(loadedNotifications.items);
        setNotificationCursor(loadedNotifications.next_cursor);
        if (loadedNotificationPreferences) {
          browserNotificationsEnabledRef.current = loadedNotificationPreferences.desktop_notifications_enabled;
          setBrowserNotificationsEnabled(loadedNotificationPreferences.desktop_notifications_enabled);
          localStorage.setItem(
            notificationPreferenceKey,
            String(loadedNotificationPreferences.desktop_notifications_enabled)
          );
          setNotificationPreferenceRaw(String(loadedNotificationPreferences.desktop_notifications_enabled));
        }
        void getPresence(accessToken, loadedUsers.map((user) => user.id))
          .then((presenceRows) => {
            setPresenceByUserId(
              Object.fromEntries(presenceRows.map((presence) => [presence.user_id, presence]))
            );
          })
          .catch(() => undefined);
        setSidebarActivity(readSidebarActivity(loadedUser.id));
        setSelected(loadedGroups[0] ? { type: "group", groupId: loadedGroups[0].id } : { type: "empty" });
      } catch (caughtError) {
        setError(getLocalizedApiError(caughtError, dictionary.session));
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
    if (!currentUser || deepLinkHandledRef.current) return;
    const parameters = new URLSearchParams(window.location.search);
    const chatType = parameters.get("chatType");
    const chatId = parameters.get("chatId");
    const messageId = parameters.get("messageId");
    if (!chatType && !chatId && !messageId) {
      deepLinkHandledRef.current = true;
      return;
    }
    deepLinkHandledRef.current = true;
    if ((chatType !== "group" && chatType !== "direct" && chatType !== "discussion") || !chatId || !messageId) {
      setError(dictionary.messageSearch.jumpError);
      router.replace(`/${locale}/app`);
      return;
    }
    void openMessageContext(chatType, chatId, messageId).catch(() => {
      setError(dictionary.messageSearch.jumpError);
    });
  }, [currentUser?.id]);

  useEffect(() => {
    const token = getStoredAccessToken();
    if (!token || selectedMembers.length === 0) return;
    void getPresence(token, selectedMembers.map((member) => member.user_id))
      .then((rows) => setPresenceByUserId((current) => ({
        ...current,
        ...Object.fromEntries(rows.map((presence) => [presence.user_id, presence]))
      })))
      .catch(() => undefined);
  }, [selectedMembers]);

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
    if (!isNotificationCenterOpen || !currentUser) {
      return;
    }
    void reloadNotifications(notificationCenterFilter);
  }, [isNotificationCenterOpen, notificationCenterFilter, currentUser?.id]);

  useEffect(() => {
    if (!currentUser || groups.length === 0) {
      return;
    }

    const token = getStoredAccessToken();
    if (!token) {
      return;
    }
    const accessToken = token;

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
    if (!currentUser) {
      return;
    }
    const activeUser = currentUser;

    const token = getStoredAccessToken();
    if (!token) {
      return;
    }
    const accessToken = token;

    function handleGroupPersonalEvent(payload: Extract<PersonalNotificationEvent, { type: "user.group.message.created" }>) {
      const currentSelection = selectedRef.current;
      const isSelectedGroup = currentSelection.type === "group" && currentSelection.groupId === payload.group_id;
      const isOwnMessage = payload.message.sender_user_id === activeUser.id;
      const isMentioned = payload.mentioned_user_ids.includes(activeUser.id);
      updateGroupActivity(
        payload.group_id,
        payload.message,
        !isSelectedGroup && !isOwnMessage,
        isMentioned && !isSelectedGroup && !isOwnMessage
      );

      const preview = getGroupMessagePreview(payload.message);
      attemptBrowserNotification({
        eventType: payload.type,
        messageId: payload.message.id,
        senderUserId: payload.message.sender_user_id,
        body: isMentioned
          ? dictionary.messages.mentionedYou
              .replace("{group_name}", payload.group.name)
              .replace("{preview}", preview)
          : `${payload.group.name} - ${payload.message.sender.display_name}: ${preview}`,
        selectedChatId: getSelectionDebugId(currentSelection),
        onClick: () => {
          setSelected({ type: "group", groupId: payload.group_id });
          setActiveDiscussionId(null);
          markGroupRead(payload.group_id);
        }
      });
    }

    function handleDirectPersonalEvent(payload: Extract<PersonalNotificationEvent, { type: "user.direct.message.created" }>) {
      const currentSelection = selectedRef.current;
      const isSelectedConversation =
        currentSelection.type === "direct" && currentSelection.conversationId === payload.conversation_id;
      const isOwnMessage = payload.message.sender_user_id === activeUser.id;
      upsertPersonalDirectConversation(payload);
      updateDirectUserActivity(payload.other_user.id, payload.message, !isSelectedConversation && !isOwnMessage);

      const preview = getNotificationMessagePreview(payload.message);
      attemptBrowserNotification({
        eventType: payload.type,
        messageId: payload.message.id,
        senderUserId: payload.message.sender_user_id,
        body: `${payload.message.sender.display_name}: ${preview}`,
        selectedChatId: getSelectionDebugId(currentSelection),
        onClick: () => {
          setSelected({ type: "direct", conversationId: payload.conversation_id });
          setActiveDiscussionId(null);
          markDirectUserRead(payload.other_user.id);
        }
      });
    }

    function handleDiscussionPersonalEvent(
      payload: Extract<PersonalNotificationEvent, { type: "user.discussion.message.created" }>
    ) {
      const currentSelection = selectedRef.current;
      const preview = payload.message.is_deleted
        ? dictionary.messages.deletedMessage
        : getNotificationMessagePreview(payload.message);
      attemptBrowserNotification({
        eventType: payload.type,
        messageId: payload.message.id,
        senderUserId: payload.message.sender_user_id,
        body: dictionary.discussions.newMessageNotification.replace("{preview}", preview),
        selectedChatId: getSelectionDebugId(currentSelection),
        onClick: () => {
          setSelected({ type: "group", groupId: payload.discussion.source_group_id });
          setActiveDiscussionId(payload.discussion_id);
        }
      });
    }

    function handleAnnouncementCreated(payload: Extract<PersonalNotificationEvent, { type: "announcement.created" }>) {
      setAnnouncementUnreadCount(payload.unread_count);
      setAnnouncementReloadKey((value) => value + 1);
      attemptBrowserNotification({
        eventType: payload.type,
        messageId: payload.announcement.id,
        senderUserId: payload.announcement.sender_user_id ?? "-",
        body: `${payload.announcement.sender_display_name}: ${payload.announcement.title}`,
        selectedChatId: getSelectionDebugId(selectedRef.current),
        onClick: () => {
          setSelected({ type: "announcements" });
          setActiveDiscussionId(null);
        }
      });
    }

    function handleCalendarEvent(payload: Extract<PersonalNotificationEvent, { type: "calendar.event_created" | "calendar.event_updated" | "calendar.event_cancelled" | "calendar.reminder" }>) {
      setLatestCalendarEvent(payload.event);
      const body = payload.type === "calendar.reminder"
        ? dictionary.calendar.desktopReminder.replace("{title}", payload.event.title)
        : `${dictionary.calendar.title}: ${payload.event.title}`;
      attemptBrowserNotification({
        eventType: payload.type,
        messageId: payload.event.id,
        senderUserId: payload.event.created_by.id ?? "-",
        body,
        selectedChatId: getSelectionDebugId(selectedRef.current),
        onClick: () => {
          setSelected({ type: "calendar" });
          setActiveDiscussionId(null);
          clearMessageContext();
        }
      });
    }

    return connectResilientWebSocket({
      getUrl: () => getPersonalWebSocketUrl(accessToken),
      heartbeatIntervalMs: presenceHeartbeatIntervalMs,
      onStatusChange: (status) => {
        setPersonalSocketStatus(status);
        if (status === "connected") void unreadStore.reload();
      },
      onForbidden: () => setError(dictionary.session.accessDenied),
      onMessage: (event) => {
        try {
          const payload = JSON.parse(event.data as string) as PersonalNotificationEvent;
          if (payload.type === "unread.updated") {
            unreadStore.applyUnreadEvent(payload);
            return;
          }
          if (payload.type === "unread.refresh") {
            void unreadStore.reload();
            return;
          }
          if (payload.type === "presence.updated") {
            setPresenceByUserId((current) => ({
              ...current,
              [payload.user_id]: {
                user_id: payload.user_id,
                status: payload.status,
                last_seen_at: payload.last_seen_at
              }
            }));
            return;
          }
          if (payload.type === "permissions.updated") {
            setCurrentUser((user) => (user ? { ...user, permissions: payload.permissions } : user));
            return;
          }
          if (payload.type === "announcement.created") {
            handleAnnouncementCreated(payload);
            return;
          }
          if (payload.type === "announcement.read" || payload.type === "announcement.retracted") {
            setAnnouncementUnreadCount(payload.unread_count);
            setAnnouncementReloadKey((value) => value + 1);
            return;
          }
          if (
            payload.type === "calendar.event_created" ||
            payload.type === "calendar.event_updated" ||
            payload.type === "calendar.event_cancelled" ||
            payload.type === "calendar.reminder"
          ) {
            handleCalendarEvent(payload);
            return;
          }
          if (payload.type === "notification.created") {
            upsertNotification(payload.notification);
            setNotificationUnreadCount(payload.unread_count);
            attemptBrowserNotification({
              eventType: payload.type,
              messageId: payload.notification.message_id ?? payload.notification.id,
              senderUserId: payload.notification.actor.id ?? "-",
              body: `${payload.notification.actor.display_name ?? dictionary.notifications.title}: ${
                dictionary.notifications.desktopGeneric
              }`,
              selectedChatId: getSelectionDebugId(selectedRef.current),
              onClick: () => {
                setIsNotificationCenterOpen(true);
                void openCenterNotification(payload.notification);
              }
            });
            return;
          }
          if (payload.type === "notification.read") {
            setNotificationUnreadCount(payload.unread_count);
            setNotificationItems((current) =>
              current.map((item) =>
                item.id === payload.notification_id
                  ? { ...item, is_read: true, read_at: item.read_at ?? new Date().toISOString() }
                  : item
              )
            );
            return;
          }
          if (payload.type === "notifications.read_all") {
            setNotificationUnreadCount(payload.unread_count);
            setNotificationItems((current) =>
              current.map((item) =>
                payload.category && item.category !== payload.category
                  ? item
                  : { ...item, is_read: true, read_at: item.read_at ?? new Date().toISOString() }
              )
            );
            return;
          }
          if (payload.type === "notification.dismissed") {
            setNotificationUnreadCount(payload.unread_count);
            removeNotification(payload.notification_id);
            return;
          }
          if (payload.type === "notification.preferences_updated") {
            setNotificationPreferences(payload.preferences);
            browserNotificationsEnabledRef.current = payload.preferences.desktop_notifications_enabled;
            setBrowserNotificationsEnabled(payload.preferences.desktop_notifications_enabled);
            localStorage.setItem(notificationPreferenceKey, String(payload.preferences.desktop_notifications_enabled));
            setNotificationPreferenceRaw(String(payload.preferences.desktop_notifications_enabled));
            return;
          }
          if (payload.type === "user.group.message.created") {
            handleGroupPersonalEvent(payload);
            return;
          }
          if (payload.type === "user.direct.message.created") {
            handleDirectPersonalEvent(payload);
            return;
          }
          if (payload.type === "user.discussion.message.created") {
            handleDiscussionPersonalEvent(payload);
          }
        } catch {
          return;
        }
      }
    });
  }, [
    currentUser,
    dictionary.discussions.newMessageNotification,
    dictionary.session.accessDenied,
    dictionary.messages.deletedMessage,
    dictionary.messages.mentionedYou,
    updateDirectUserActivity,
    updateGroupActivity,
    unreadStore.applyUnreadEvent,
    unreadStore.reload
  ]);

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

    let stopped = false;
    async function refreshDirectConversations() {
      if (stopped) return;
      try {
        const loadedConversations = await getDirectConversations(accessToken);
        if (stopped) return;
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
    const unsubscribe = onAuthenticationExpired(() => {
      stopped = true;
      clearInterval(timer);
    });
    return () => {
      stopped = true;
      clearInterval(timer);
      unsubscribe();
    };
  }, [currentUser, selected, dictionary.messages.deletedMessage, dictionary.sidebarActivity.noRecentMessages]);

  function updateSettings(nextSettings: AppSettings) {
    setSettings(nextSettings);
    // TODO: Persist app settings in backend user_preferences instead of localStorage.
    localStorage.setItem(settingsKey, JSON.stringify(nextSettings));
  }

  function setActiveSidebarTab(nextTab: SidebarTab) {
    setSidebarTab(nextTab);
  }

  function resetSidebarWidth() {
    setSidebarWidth(defaultSidebarWidth);
  }

  function handleSidebarResizeStart(event: ReactPointerEvent<HTMLDivElement>) {
    if (isSidebarCollapsed || event.button !== 0) {
      return;
    }
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = sidebarWidth;
    const direction = settings.sidebarSide === "right" ? -1 : 1;
    document.body.classList.add("sidebar-resizing");

    function handlePointerMove(pointerEvent: PointerEvent) {
      const nextWidth = Math.min(
        maximumSidebarWidth,
        Math.max(minimumSidebarWidth, startWidth + (pointerEvent.clientX - startX) * direction)
      );
      setSidebarWidth(Math.round(nextWidth));
    }

    function handlePointerUp() {
      document.body.classList.remove("sidebar-resizing");
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", handlePointerUp);
    }

    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", handlePointerUp);
  }

  function handleSidebarResizeKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
    const direction = settings.sidebarSide === "right" ? -1 : 1;
    if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
      event.preventDefault();
      const delta = (event.key === "ArrowRight" ? 16 : -16) * direction;
      setSidebarWidth((currentWidth) =>
        Math.min(maximumSidebarWidth, Math.max(minimumSidebarWidth, currentWidth + delta))
      );
    }
  }

  function handleLanguageChange(nextLocale: Locale) {
    updateSettings({ ...settings, language: nextLocale });
    router.push(`/${nextLocale}/app`);
  }

  function updateBrowserNotificationsEnabled(isEnabled: boolean) {
    browserNotificationsEnabledRef.current = isEnabled;
    setBrowserNotificationsEnabled(isEnabled);
    localStorage.setItem(notificationPreferenceKey, String(isEnabled));
    setNotificationPreferenceRaw(String(isEnabled));
    const token = getStoredAccessToken();
    if (token) {
      void updateNotificationPreferences(token, { desktop_notifications_enabled: isEnabled })
        .then(setNotificationPreferences)
        .catch(() => undefined);
    }
  }

  async function updateNotificationPreferenceField(
    field: keyof Pick<
      NotificationPreferences,
      | "mentions_enabled"
      | "replies_enabled"
      | "reactions_enabled"
      | "direct_messages_enabled"
      | "group_messages_enabled"
      | "discussion_messages_enabled"
      | "announcements_enabled"
      | "pins_enabled"
      | "calendar_events_enabled"
      | "calendar_reminders_enabled"
      | "calendar_changes_enabled"
      | "system_enabled"
      | "desktop_notifications_enabled"
      | "sound_enabled"
    >,
    value: boolean
  ) {
    const token = getStoredAccessToken();
    if (!token) return;
    const previousPreferences = notificationPreferences;
    if (previousPreferences) {
      setNotificationPreferences({ ...previousPreferences, [field]: value });
    }
    try {
      const nextPreferences = await updateNotificationPreferences(token, { [field]: value });
      setNotificationPreferences(nextPreferences);
      if (field === "desktop_notifications_enabled") {
        browserNotificationsEnabledRef.current = nextPreferences.desktop_notifications_enabled;
        setBrowserNotificationsEnabled(nextPreferences.desktop_notifications_enabled);
        localStorage.setItem(notificationPreferenceKey, String(nextPreferences.desktop_notifications_enabled));
        setNotificationPreferenceRaw(String(nextPreferences.desktop_notifications_enabled));
      }
    } catch {
      if (previousPreferences) setNotificationPreferences(previousPreferences);
      setError(dictionary.notifications.preferencesError);
    }
  }

  async function requestBrowserNotificationPermission() {
    if (typeof window === "undefined" || !("Notification" in window)) {
      setNotificationPermission("unsupported");
      updateBrowserNotificationsEnabled(false);
      return;
    }

    const permission = await Notification.requestPermission();
    notificationPermissionRef.current = permission;
    setNotificationPermission(permission);
    updateBrowserNotificationsEnabled(permission === "granted");
  }

  function sendTestBrowserNotification() {
    const permission = getBrowserNotificationPermission();
    const enabledValue = readNotificationPreferenceRaw();
    const visibilityState = getCurrentVisibilityState();
    const windowFocused = getCurrentWindowFocusState();
    notificationPermissionRef.current = permission;
    setNotificationPermission(permission);
    setNotificationPreferenceRaw(enabledValue);
    visibilityStateRef.current = visibilityState;
    windowFocusedRef.current = windowFocused;
    setDocumentVisibilityState(visibilityState);
    setIsWindowFocused(windowFocused);

    const baseDebug: BrowserNotificationDebug = {
      eventType: "test.notification",
      messageId: "test",
      senderUserId: currentUser?.id ?? "-",
      currentUserId: currentUser?.id ?? "-",
      selectedChatId: getSelectedChatDebugId(),
      permission,
      enabledValue,
      visibilityState,
      windowFocused,
      attempted: false,
      result: "skipped",
      skipReason: "none",
      error: "",
      timestamp: new Date().toISOString()
    };

    if (typeof window === "undefined" || !("Notification" in window)) {
      setTestNotificationStatus(dictionary.appShell.notificationTestPermissionRequired);
      recordNotificationDebug({ ...baseDebug, skipReason: "unsupported" });
      return;
    }

    if (permission !== "granted") {
      setTestNotificationStatus(dictionary.appShell.notificationTestPermissionRequired);
      recordNotificationDebug({ ...baseDebug, skipReason: "permissionNotGranted" });
      return;
    }

    try {
      const notification = new Notification("OfficeChat", { body: "Test notification" });
      notification.onclick = () => window.focus();
      setTestNotificationStatus(dictionary.appShell.notificationTestSent);
      recordNotificationDebug({
        ...baseDebug,
        attempted: true,
        result: "sent",
        skipReason: "none"
      });
    } catch (caughtError) {
      const errorMessage = caughtError instanceof Error ? caughtError.message : String(caughtError);
      setTestNotificationStatus(errorMessage);
      recordNotificationDebug({
        ...baseDebug,
        attempted: true,
        result: "failed",
        skipReason: "constructorError",
        error: errorMessage
      });
    }
  }

  function openProfile() {
    if (!currentUser) {
      return;
    }
    setProfileDisplayName(currentUser.display_name);
    setProfileSuccess("");
    setProfileError("");
    setSelectedAvatarFile(null);
    if (avatarInputRef.current) avatarInputRef.current.value = "";
    setIsProfileOpen(true);
  }

  function formatProfileDate(timestamp: string | null) {
    return timestamp ? profileDateFormatter.format(new Date(timestamp)) : dictionary.appShell.profile.notAvailable;
  }

  async function saveProfile() {
    const token = getStoredAccessToken();
    if (!token) {
      router.replace(`/${locale}/login`);
      return;
    }

    setProfileSuccess("");
    setProfileError("");
    setIsProfileSaving(true);
    try {
      const updatedUser = await updateCurrentUser(token, profileDisplayName);
      setCurrentUser(updatedUser);
      setProfileDisplayName(updatedUser.display_name);
      setProfileSuccess(dictionary.appShell.profile.updateSuccess);
    } catch (caughtError) {
      setProfileError(caughtError instanceof Error ? caughtError.message : dictionary.appShell.profile.updateError);
    } finally {
      setIsProfileSaving(false);
    }
  }

  function getAvatarUploadError(caughtError: unknown) {
    const message = caughtError instanceof Error ? caughtError.message : "";
    if (message.includes("exceeds")) return dictionary.appShell.profile.avatarFileTooLarge;
    if (message.includes("format") || message.includes("content type") || message.includes("valid supported image")) {
      return dictionary.appShell.profile.avatarUnsupportedFormat;
    }
    return message || dictionary.appShell.profile.avatarUploadError;
  }

  async function handleAvatarFile(file: File | null) {
    setSelectedAvatarFile(file);
    if (!file) return;
    const token = getStoredAccessToken();
    if (!token) {
      router.replace(`/${locale}/login`);
      return;
    }
    setProfileSuccess("");
    setProfileError("");
    setIsAvatarUploading(true);
    try {
      const updatedUser = await uploadMyAvatar(token, file);
      setCurrentUser(updatedUser);
      setProfileSuccess(dictionary.appShell.profile.avatarUpdated);
      setSelectedAvatarFile(null);
      if (avatarInputRef.current) avatarInputRef.current.value = "";
    } catch (caughtError) {
      setProfileError(getAvatarUploadError(caughtError));
    } finally {
      setIsAvatarUploading(false);
    }
  }

  async function handleDeleteAvatar() {
    const token = getStoredAccessToken();
    if (!token) {
      router.replace(`/${locale}/login`);
      return;
    }
    setProfileSuccess("");
    setProfileError("");
    setIsAvatarUploading(true);
    try {
      const updatedUser = await deleteMyAvatar(token);
      setCurrentUser(updatedUser);
      setSelectedAvatarFile(null);
      setProfileSuccess(dictionary.appShell.profile.avatarRemoved);
    } catch (caughtError) {
      setProfileError(caughtError instanceof Error ? caughtError.message : dictionary.appShell.profile.avatarUploadError);
    } finally {
      setIsAvatarUploading(false);
    }
  }

  async function logout() {
    await logoutSession(locale);
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
      setActiveDiscussionId(null);
      clearMessageContext();
    } catch (caughtError) {
      setError(caughtError instanceof Error && caughtError.name !== "AbortError" ? caughtError.message : dictionary.appShell.loadError);
    } finally {
      clearTimeout(timeout);
      setPendingDirectUsername(null);
    }
  }

  function closeMessageSearch() {
    setIsMessageSearchOpen(false);
    requestAnimationFrame(() => messageSearchTriggerRef.current?.focus());
  }

  function clearMessageContext() {
    setMessageContext(null);
    if (typeof window !== "undefined" && window.location.search) {
      router.replace(`/${locale}/app`, { scroll: false });
    }
  }

  async function openMessageContext(
    chatType: "group" | "direct" | "discussion",
    chatId: string,
    messageId: string,
    sourceGroupId?: string | null
  ) {
    const token = getStoredAccessToken();
    if (!token) throw new Error(dictionary.messageSearch.jumpError);
    const context = await getMessageContext(token, chatType, chatId, messageId);
    if (chatType === "group") {
      if (!groups.some((group) => group.id === chatId)) throw new Error(dictionary.messageSearch.jumpError);
      setSelected({ type: "group", groupId: chatId });
      setActiveDiscussionId(null);
    } else if (chatType === "direct") {
      let conversations = directConversations;
      if (!conversations.some((conversation) => conversation.id === chatId)) {
        conversations = await getDirectConversations(token);
        setDirectConversations(conversations);
      }
      if (!conversations.some((conversation) => conversation.id === chatId)) {
        throw new Error(dictionary.messageSearch.jumpError);
      }
      setSelected({ type: "direct", conversationId: chatId });
      setActiveDiscussionId(null);
    } else {
      const groupId = sourceGroupId ?? (await getDiscussion(token, chatId)).source_group_id;
      if (!groups.some((group) => group.id === groupId)) throw new Error(dictionary.messageSearch.jumpError);
      setSelected({ type: "group", groupId });
      setActiveDiscussionId(chatId);
    }
    setMessageContext(context);
    setIsMessageSearchOpen(false);
    router.replace(
      `/${locale}/app?chatType=${chatType}&chatId=${encodeURIComponent(chatId)}&messageId=${encodeURIComponent(messageId)}`,
      { scroll: false }
    );
  }

  async function handleSearchJump(result: OfficeChatMessageSearchResult) {
    await openMessageContext(
      result.chat_type,
      result.chat_id,
      result.message_id,
      result.source_group_id
    );
  }

  async function expandMessageContext(before: number, after: number) {
    if (!messageContext) return;
    const token = getStoredAccessToken();
    if (!token) throw new Error(dictionary.messageSearch.jumpError);
    setMessageContext(
      await getMessageContext(
        token,
        messageContext.chat_type,
        messageContext.chat_id,
        messageContext.target_message_id,
        Math.min(100, before),
        Math.min(100, after)
      )
    );
  }

  function getInitials(value: string) {
    const parts = value.trim().split(/\s+/).filter(Boolean);
    return (parts.length > 1 ? `${parts[0][0]}${parts[1][0]}` : parts[0]?.slice(0, 2) || "OC").toUpperCase();
  }

  function closeChatOnSmallScreen() {
    setSelected({ type: "empty" });
    setActiveDiscussionId(null);
    clearMessageContext();
  }

  return (
    <main className={appShellClass} style={appShellStyle}>
      <div className="user-app-layout">
        <aside className="user-app-sidebar" aria-label={dictionary.appShell.sidebarAriaLabel}>
          <div className="messenger-sidebar-header">
            <div className="messenger-brand">
              <BrandLogo compact={isSidebarCollapsed} tagline={localizedBrand.tagline} variant="dark" />
            </div>
            <button
              aria-label={isSidebarCollapsed ? dictionary.appShell.expandSidebar : dictionary.appShell.collapseSidebar}
              className="sidebar-icon-button"
              onClick={() => setIsSidebarCollapsed((current) => !current)}
              title={isSidebarCollapsed ? dictionary.appShell.expandSidebar : dictionary.appShell.collapseSidebar}
              type="button"
            >
              {isSidebarCollapsed ? ">" : "<"}
            </button>
          </div>

          <div className="messenger-sidebar-tools">
            <div className="sidebar-search-row">
              <input
                aria-label={dictionary.appShell.sidebarSearch}
                className="field-input user-app-sidebar-search"
                onChange={(event) => setSidebarSearch(event.target.value)}
                placeholder={dictionary.appShell.sidebarSearch}
                type="search"
                value={sidebarSearch}
              />
              <button
                aria-label={dictionary.messageSearch.searchButton}
                className="sidebar-icon-button message-search-trigger"
                onClick={() => setIsMessageSearchOpen(true)}
                ref={messageSearchTriggerRef}
                title={`${dictionary.messageSearch.searchButton} (Ctrl+K)`}
                type="button"
              >
                ⌕
              </button>
            </div>
            <div className="sidebar-tabs" role="tablist" aria-label={dictionary.appShell.chatTabs}>
              {(["all", "groups", "direct"] as SidebarTab[]).map((tab) => {
                const unreadCount = tab === "all"
                  ? unreadStore.summary.total
                  : tab === "groups"
                    ? unreadStore.summary.groups
                    : unreadStore.summary.direct;
                return <button
                  aria-selected={sidebarTab === tab}
                  className={sidebarTab === tab ? "sidebar-tab sidebar-tab-active" : "sidebar-tab"}
                  key={tab}
                  onClick={() => setActiveSidebarTab(tab)}
                  role="tab"
                  type="button"
                >
                  <span>{dictionary.appShell.tabs[tab]}</span>
                  {unreadCount > 0 ? (
                    <span
                      aria-label={dictionary.unread.counterLabel.replace("{count}", String(unreadCount))}
                      className="sidebar-tab-badge"
                      title={dictionary.unread.counterLabel.replace("{count}", String(unreadCount))}
                    >
                      {formatUnreadCount(unreadCount)}
                    </span>
                  ) : null}
                </button>;
              })}
            </div>
            {unreadStore.isLoading ? (
              <span className="visually-hidden" role="status">{dictionary.unread.loading}</span>
            ) : null}
            {unreadStore.error ? (
              <p className="sidebar-unread-error" title={unreadStore.error}>{dictionary.unread.error}</p>
            ) : null}
          </div>

          <div className="user-app-nav-list">
            <button
              aria-label={dictionary.announcements.title}
              className={[
                "user-app-nav-item",
                "user-app-nav-item-announcements",
                selected.type === "announcements" ? "user-app-nav-item-active" : "",
                announcementUnreadCount > 0 ? "user-app-nav-item-unread" : ""
              ].filter(Boolean).join(" ")}
              onClick={() => {
                setSelected({ type: "announcements" });
                setActiveDiscussionId(null);
                clearMessageContext();
              }}
              title={isSidebarCollapsed ? dictionary.announcements.title : undefined}
              type="button"
            >
              <span className="chat-avatar chat-avatar-group" aria-hidden="true">!</span>
              <span className="sidebar-item-content">
                <span className="sidebar-item-top">
                  <strong>{dictionary.announcements.title}</strong>
                </span>
                <span className="sidebar-item-preview">{dictionary.announcements.sidebarPreview}</span>
              </span>
              <AnnouncementUnreadBadge count={announcementUnreadCount} locale={locale} />
            </button>
            <button
              aria-label={dictionary.calendar.title}
              className={[
                "user-app-nav-item",
                "user-app-nav-item-calendar",
                selected.type === "calendar" ? "user-app-nav-item-active" : ""
              ].filter(Boolean).join(" ")}
              onClick={() => {
                setSelected({ type: "calendar" });
                setActiveDiscussionId(null);
                clearMessageContext();
              }}
              title={isSidebarCollapsed ? dictionary.calendar.title : undefined}
              type="button"
            >
              <span className="chat-avatar chat-avatar-group" aria-hidden="true">C</span>
              <span className="sidebar-item-content">
                <span className="sidebar-item-top">
                  <strong>{dictionary.calendar.title}</strong>
                </span>
                <span className="sidebar-item-preview">{dictionary.calendar.sidebarPreview}</span>
              </span>
            </button>
            {!isLoading && normalizedSidebarSearch && !hasSidebarSearchResults ? (
              <p className="sidebar-empty-state">{dictionary.appShell.nothingFound}</p>
            ) : null}
            {sidebarChatItems.map((item) => {
              const isGroup = item.kind === "group";
              const activity = isGroup
                ? sidebarActivity.groups[item.group.id]
                : sidebarActivity.directUsers[item.user.id];
              const name = isGroup ? item.group.name : item.user.display_name;
              const secondary = isGroup ? item.group.slug : `@${item.user.username}`;
              const isSelected = isGroup
                ? selected.type === "group" && selected.groupId === item.group.id
                : selected.type === "direct" && selectedDirectConversation?.other_user.id === item.user.id;
              const directConversation = isGroup
                ? null
                : directConversations.find((conversation) => conversation.other_user.id === item.user.id);
              const serverUnread = unreadStore.getChat(
                isGroup ? "group" : "direct",
                isGroup ? item.group.id : directConversation?.id ?? ""
              );
              const itemClassName = [
                "user-app-nav-item",
                isSelected ? "user-app-nav-item-active" : "",
                serverUnread?.unread_count ? "user-app-nav-item-unread" : "",
                serverUnread?.mention_count ? "user-app-nav-item-mentioned" : ""
              ].filter(Boolean).join(" ");
              return (
                <button
                  aria-label={`${name}, ${secondary}`}
                  className={itemClassName}
                  disabled={!isGroup && pendingDirectUsername === item.user.username}
                  key={`${item.kind}-${item.id}`}
                  onClick={() => {
                    if (isGroup) {
                      setSelected({ type: "group", groupId: item.group.id });
                      setActiveDiscussionId(null);
                      clearMessageContext();
                      markGroupRead(item.group.id);
                    } else {
                      void handleOpenDirectUser(item.user);
                    }
                  }}
                  title={isSidebarCollapsed ? name : undefined}
                  type="button"
                >
                  {isGroup ? (
                    <span className="chat-avatar chat-avatar-group" aria-hidden="true">{getInitials(name)}</span>
                  ) : (
                    <span className="presence-avatar-wrap">
                      <UserAvatar user={item.user} size={40} />
                      <PresenceStatus
                        compact
                        dictionary={dictionary}
                        locale={locale}
                        presence={presenceByUserId[item.user.id]}
                      />
                    </span>
                  )}
                  <span className="sidebar-item-content">
                    <span className="sidebar-item-top">
                      <strong>{name}</strong>
                      {activity?.timestamp ? <span className="sidebar-item-time">{formatActivityTime(activity.timestamp)}</span> : null}
                    </span>
                    <span className="sidebar-item-preview">{activity?.preview || dictionary.sidebarActivity.noRecentMessages}</span>
                    <span className="sidebar-item-meta">{secondary}</span>
                  </span>
                  {serverUnread?.unread_count ? (
                    <span
                      aria-label={dictionary.unread.counterLabel.replace("{count}", String(serverUnread.unread_count))}
                      className="sidebar-unread-badge"
                      title={dictionary.unread.counterLabel.replace("{count}", String(serverUnread.unread_count))}
                    >{formatUnreadCount(serverUnread.unread_count)}</span>
                  ) : null}
                  {serverUnread?.mention_count ? (
                    <span
                      aria-label={dictionary.unread.mentionLabel.replace("{count}", String(serverUnread.mention_count))}
                      className="sidebar-unread-badge sidebar-unread-badge-mention"
                      title={dictionary.unread.mentionLabel.replace("{count}", String(serverUnread.mention_count))}
                    >@{formatUnreadCount(serverUnread.mention_count)}</span>
                  ) : null}
                </button>
              );
            })}
            {!isLoading && !normalizedSidebarSearch && sidebarChatItems.length === 0 ? (
              <p className="sidebar-empty-state">
                {sidebarTab === "groups" ? dictionary.appShell.noGroups : sidebarTab === "direct" ? dictionary.appShell.noUsers : dictionary.appShell.nothingFound}
              </p>
            ) : null}
          </div>

          <div className="messenger-sidebar-account">
            {currentUser ? (
              <button className="sidebar-account-button" onClick={openProfile} title={dictionary.appShell.profile.open} type="button">
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
                onClick={() => setIsNotificationCenterOpen(true)}
                unreadCount={notificationUnreadCount}
              />
              <button
                aria-label={dictionary.appShell.settings}
                className="sidebar-icon-button"
                onClick={() => setIsSettingsOpen(true)}
                title={dictionary.appShell.settings}
                type="button"
              >
                ⚙
              </button>
              {currentUser && isAdminRole(currentUser.role) ? (
                <>
                  <Link
                    aria-label={dictionary.appShell.admin}
                    className="sidebar-icon-button"
                    href={`/${locale}/admin/users`}
                    title={dictionary.appShell.admin}
                  >
                    A
                  </Link>
                  <Link
                    aria-label={dictionary.retention.title}
                    className="sidebar-icon-button"
                    href={`/${locale}/admin/storage`}
                    title={dictionary.retention.title}
                  >
                    S
                  </Link>
                  <Link
                    aria-label={dictionary.audit.title}
                    className="sidebar-icon-button"
                    href={`/${locale}/admin/audit`}
                    title={dictionary.audit.title}
                  >
                    L
                  </Link>
                </>
              ) : null}
              <button
                aria-label={dictionary.dashboard.logout}
                className="sidebar-icon-button"
                onClick={logout}
                title={dictionary.dashboard.logout}
                type="button"
              >
                ↪
              </button>
            </div>
          </div>
        </aside>

        <div
          aria-label={dictionary.appShell.resizeSidebar}
          aria-orientation="vertical"
          aria-valuemax={maximumSidebarWidth}
          aria-valuemin={minimumSidebarWidth}
          aria-valuenow={sidebarWidth}
          className="sidebar-resize-handle"
          onDoubleClick={resetSidebarWidth}
          onKeyDown={handleSidebarResizeKeyDown}
          onPointerDown={handleSidebarResizeStart}
          role="separator"
          tabIndex={isSidebarCollapsed ? -1 : 0}
          title={dictionary.appShell.resetSidebarWidth}
        />

        <section className="user-app-main" aria-label={dictionary.appShell.mainAriaLabel}>
          {error ? <p className="form-error">{error}</p> : null}
          {isLoading ? <p className="muted">{dictionary.appShell.loading}</p> : null}

          {!isLoading && selected.type === "empty" ? (
            <div className="user-app-placeholder">
              <h2>{dictionary.appShell.emptyTitle}</h2>
              <p>{dictionary.appShell.emptyDescription}</p>
            </div>
          ) : null}

          {!isLoading && selected.type === "announcements" && currentUser ? (
            <AnnouncementsPanel
              currentUser={currentUser}
              dictionary={dictionary}
              groups={groups}
              locale={locale}
              reloadKey={announcementReloadKey}
              users={users}
              onUnreadChange={setAnnouncementUnreadCount}
            />
          ) : null}

          {!isLoading && selected.type === "calendar" && currentUser ? (
            <CalendarPanel
              currentUser={currentUser}
              dictionary={dictionary}
              externalEvent={latestCalendarEvent}
              groups={groups}
              locale={locale}
              users={users}
            />
          ) : null}

          {selectedGroup && currentUser ? (
            <div className={activeDiscussionId ? "user-app-chat-layout user-app-chat-layout-discussion" : "user-app-chat-layout"}>
              <div className="user-app-chat-primary">
                <div className="user-app-chat-heading">
                  <button className="mobile-chat-back" onClick={closeChatOnSmallScreen} type="button">
                    {dictionary.appShell.backToChats}
                  </button>
                  <div className="chat-header-identity">
                    <span className="chat-avatar chat-avatar-group" aria-hidden="true">{getInitials(selectedGroup.name)}</span>
                    <div>
                      <h2 className="section-title">{selectedGroup.name}</h2>
                      <p className="admin-current">
                        {selectedGroup.slug} · {dictionary.appShell.membersCount.replace("{count}", String(selectedMembers.length))}
                      </p>
                    </div>
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
                  onDiscuss={(message) => void handleOpenDiscussion(message)}
                  onMarkRead={(messageId) => unreadStore.markRead("group", selectedGroup.id, messageId)}
                  unread={unreadStore.getChat("group", selectedGroup.id)}
                  messageContext={messageContext?.chat_type === "group" && messageContext.chat_id === selectedGroup.id ? messageContext : null}
                  onContextClosed={clearMessageContext}
                  onContextExpand={expandMessageContext}
                  onJumpToMessage={(messageId) => openMessageContext("group", selectedGroup.id, messageId)}
                />
              </div>
              {activeDiscussionId ? (
                <DiscussionPanel
                  currentUser={currentUser}
                  dictionary={dictionary}
                  discussionId={activeDiscussionId}
                  locale={locale}
                  onClose={() => {
                    setActiveDiscussionId(null);
                    clearMessageContext();
                  }}
                  presenceByUserId={presenceByUserId}
                  onMarkRead={(messageId) => unreadStore.markRead("discussion", activeDiscussionId, messageId)}
                  unread={unreadStore.getChat("discussion", activeDiscussionId)}
                  messageContext={messageContext?.chat_type === "discussion" && messageContext.chat_id === activeDiscussionId ? messageContext : null}
                  onContextClosed={clearMessageContext}
                  onContextExpand={expandMessageContext}
                  onJumpToMessage={(messageId) => openMessageContext("discussion", activeDiscussionId, messageId, selectedGroup.id)}
                />
              ) : null}
            </div>
          ) : null}

          {selectedDirectConversation && currentUser ? (
            <div className="user-app-chat-layout">
              <div className="user-app-chat-heading">
                <button className="mobile-chat-back" onClick={closeChatOnSmallScreen} type="button">
                  {dictionary.appShell.backToChats}
                </button>
                <div className="chat-header-identity">
                  <UserAvatar user={selectedDirectConversation.other_user} size={40} />
                  <div>
                    <h2 className="section-title">{selectedDirectConversation.other_user.display_name}</h2>
                    <p className="admin-current">@{selectedDirectConversation.other_user.username}</p>
                    <PresenceStatus
                      dictionary={dictionary}
                      locale={locale}
                      presence={presenceByUserId[selectedDirectConversation.other_user.id]}
                    />
                  </div>
                </div>
              </div>
              <DirectChatPanel
                conversation={selectedDirectConversation}
                currentUser={currentUser}
                dictionary={dictionary}
                locale={locale}
                onMarkRead={(messageId) => unreadStore.markRead("direct", selectedDirectConversation.id, messageId)}
                unread={unreadStore.getChat("direct", selectedDirectConversation.id)}
                messageContext={messageContext?.chat_type === "direct" && messageContext.chat_id === selectedDirectConversation.id ? messageContext : null}
                onContextClosed={clearMessageContext}
                onContextExpand={expandMessageContext}
                onJumpToMessage={(messageId) => openMessageContext("direct", selectedDirectConversation.id, messageId)}
              />
            </div>
          ) : null}
        </section>
      </div>

      {isMessageSearchOpen ? (
        <MessageSearchPanel
          currentChat={currentSearchChat}
          dictionary={dictionary}
          locale={locale}
          onClose={closeMessageSearch}
          onJump={handleSearchJump}
          users={users}
        />
      ) : null}

      <NotificationCenter
        dictionary={dictionary}
        filter={notificationCenterFilter}
        hasMore={Boolean(notificationCursor)}
        isLoading={isNotificationCenterLoading}
        isOpen={isNotificationCenterOpen}
        items={notificationItems}
        locale={locale}
        onClose={() => setIsNotificationCenterOpen(false)}
        onDismiss={(notification) => void dismissCenterNotification(notification)}
        onFilterChange={setNotificationCenterFilter}
        onLoadMore={() => void loadMoreNotifications()}
        onMarkAllRead={() => void markAllCenterNotificationsRead()}
        onMarkRead={(notification) => void markCenterNotificationRead(notification)}
        onOpen={(notification) => void openCenterNotification(notification)}
        unreadCount={notificationUnreadCount}
      />

      {isProfileOpen && currentUser ? (
        <div className="settings-backdrop" role="presentation">
          <section className="settings-panel profile-panel" aria-label={dictionary.appShell.profile.title}>
            <div className="dashboard-header">
              <div>
                <p className="eyebrow">{dictionary.appShell.profile.account}</p>
                <h2 className="section-title">{dictionary.appShell.profile.title}</h2>
              </div>
              <button className="table-action" onClick={() => setIsProfileOpen(false)} type="button">
                {dictionary.appShell.close}
              </button>
            </div>
            <div className="admin-form">
              <div className="profile-avatar-section">
                <UserAvatar user={currentUser} size={96} />
                <div className="profile-avatar-controls">
                  <span className="field-label">{dictionary.appShell.profile.avatar}</span>
                  <input
                    accept="image/png,image/jpeg,image/webp"
                    className="visually-hidden"
                    onChange={(event) => void handleAvatarFile(event.target.files?.[0] ?? null)}
                    ref={avatarInputRef}
                    type="file"
                  />
                  <div className="actions">
                    <button
                      className="secondary-link"
                      disabled={isAvatarUploading}
                      onClick={() => avatarInputRef.current?.click()}
                      type="button"
                    >
                      {isAvatarUploading
                        ? dictionary.appShell.profile.avatarUploading
                        : currentUser.avatar_url
                          ? dictionary.appShell.profile.changeAvatar
                          : dictionary.appShell.profile.uploadAvatar}
                    </button>
                    {currentUser.avatar_url ? (
                      <button
                        className="table-action"
                        disabled={isAvatarUploading}
                        onClick={() => void handleDeleteAvatar()}
                        type="button"
                      >
                        {dictionary.appShell.profile.removeAvatar}
                      </button>
                    ) : null}
                  </div>
                  {selectedAvatarFile ? <p className="note">{selectedAvatarFile.name}</p> : null}
                  <p className="note">{dictionary.appShell.profile.avatarHint}</p>
                  {!currentUser.avatar_url && !selectedAvatarFile ? (
                    <p className="note">{dictionary.appShell.profile.noAvatar}</p>
                  ) : null}
                </div>
              </div>
              <label className="field">
                <span className="field-label">{dictionary.appShell.profile.displayName}</span>
                <input
                  className="field-input"
                  maxLength={160}
                  onChange={(event) => setProfileDisplayName(event.target.value)}
                  value={profileDisplayName}
                />
              </label>
              <dl className="profile-facts">
                <div>
                  <dt>{dictionary.appShell.profile.username}</dt>
                  <dd>@{currentUser.username}</dd>
                </div>
                <div>
                  <dt>{dictionary.appShell.profile.role}</dt>
                  <dd>{currentUser.role}</dd>
                </div>
                <div>
                  <dt>{dictionary.appShell.profile.authProvider}</dt>
                  <dd>{currentUser.auth_provider}</dd>
                </div>
                <div>
                  <dt>{dictionary.appShell.profile.accountStatus}</dt>
                  <dd>
                    {currentUser.is_active
                      ? dictionary.appShell.profile.active
                      : dictionary.appShell.profile.inactive}
                  </dd>
                </div>
                <div>
                  <dt>{dictionary.appShell.profile.created}</dt>
                  <dd>{formatProfileDate(currentUser.created_at)}</dd>
                </div>
                <div>
                  <dt>{dictionary.appShell.profile.lastLogin}</dt>
                  <dd>{formatProfileDate(currentUser.last_login_at)}</dd>
                </div>
              </dl>
              {profileSuccess ? <p className="form-success">{profileSuccess}</p> : null}
              {profileError ? <p className="form-error">{profileError}</p> : null}
              <button
                className="primary-button"
                disabled={isProfileSaving || !profileDisplayName.trim()}
                onClick={() => void saveProfile()}
                type="button"
              >
                {isProfileSaving ? dictionary.appShell.profile.saving : dictionary.appShell.profile.save}
              </button>
            </div>
          </section>
        </div>
      ) : null}

      {isSettingsOpen ? (
        <div className="settings-backdrop" role="presentation">
          <div className="settings-modal-stack">
          <section className="settings-panel" aria-label={dictionary.appShell.settingsTitle}>
            <div className="dashboard-header">
              <h2 className="section-title">{dictionary.appShell.settingsTitle}</h2>
              <button
                className="table-action"
                onClick={() => {
                  setIsNotificationGuideOpen(false);
                  setIsSettingsOpen(false);
                }}
                type="button"
              >
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
                  <option value="forest">{dictionary.appShell.accentForest}</option>
                </select>
              </label>
              <div className="field notification-preferences">
                <span className="field-label">{dictionary.notifications.preferencesTitle}</span>
                <p className="note">{dictionary.notifications.preferencesDescription}</p>
                {(
                  [
                    "mentions_enabled",
                    "replies_enabled",
                    "reactions_enabled",
                    "direct_messages_enabled",
                    "group_messages_enabled",
                    "discussion_messages_enabled",
                    "announcements_enabled",
                    "pins_enabled",
                    "calendar_events_enabled",
                    "calendar_reminders_enabled",
                    "calendar_changes_enabled",
                    "system_enabled",
                    "desktop_notifications_enabled",
                    "sound_enabled"
                  ] as const
                ).map((fieldName) => (
                  <label className="checkbox-field" key={fieldName}>
                    <input
                      checked={Boolean(notificationPreferences?.[fieldName])}
                      disabled={!notificationPreferences || fieldName === "system_enabled"}
                      onChange={(event) =>
                        void updateNotificationPreferenceField(fieldName, event.target.checked)
                      }
                      type="checkbox"
                    />
                    <span>{dictionary.notifications.preferences[fieldName]}</span>
                  </label>
                ))}
                <p className="note">{dictionary.notifications.preferencesPolicy}</p>
              </div>
              <div className="field">
                <span className="field-label">{dictionary.appShell.browserNotifications}</span>
                <p className="note">
                  {dictionary.appShell.notificationPermission}:{" "}
                  {dictionary.appShell.notificationPermissions[notificationPermission]}
                </p>
                <p className="note">
                  {browserNotificationsEnabled
                    ? dictionary.appShell.notificationsEnabled
                    : dictionary.appShell.notificationsDisabled}
                </p>
                <label className="checkbox-field">
                  <input
                    checked={browserNotificationsEnabled}
                    disabled={notificationPermission !== "granted"}
                    onChange={(event) => updateBrowserNotificationsEnabled(event.target.checked)}
                    type="checkbox"
                  />
                  <span>{dictionary.appShell.notificationsPreference}</span>
                </label>
                <button
                  className="secondary-link"
                  disabled={notificationPermission === "unsupported"}
                  onClick={() => void requestBrowserNotificationPermission()}
                  type="button"
                >
                  {dictionary.appShell.enableNotifications}
                </button>
                <button
                  className="secondary-link"
                  disabled={notificationPermission === "unsupported"}
                  onClick={sendTestBrowserNotification}
                  type="button"
                >
                  {dictionary.appShell.testNotification}
                </button>
                {testNotificationStatus ? <p className="form-success">{testNotificationStatus}</p> : null}
                <p className="note">{dictionary.appShell.notificationTestHelp}</p>
                <button className="secondary-link" onClick={() => setIsNotificationGuideOpen(true)} type="button">
                  {dictionary.appShell.notificationGuide.howToEnable}
                </button>
                <p className="note">{dictionary.appShell.notificationsNote}</p>
                {notificationPermission === "denied" ? (
                  <p className="form-error">{dictionary.appShell.notificationsDeniedHint}</p>
                ) : null}
                <div className="notification-debug">
                  <span className="field-label">{dictionary.appShell.notificationDebugTitle}</span>
                  <p className="note">
                    {dictionary.appShell.notificationDebugPermission}:{" "}
                    {dictionary.appShell.notificationPermissions[notificationPermission]}
                  </p>
                  <p className="note">
                    {dictionary.appShell.notificationDebugEnabled}: {notificationPreferenceRaw}
                  </p>
                  <p className="note">
                    {dictionary.appShell.notificationDebugVisibility}: {documentVisibilityState}
                  </p>
                  <p className="note">
                    {dictionary.appShell.notificationDebugFocused}:{" "}
                    {isWindowFocused ? dictionary.appShell.yes : dictionary.appShell.no}
                  </p>
                  <p className="note">
                    {dictionary.appShell.personalSocketStatus}:{" "}
                    {dictionary.appShell.personalSocketStatuses[personalSocketStatus]}
                  </p>
                  <p className="note">
                    {dictionary.appShell.notificationDebugLastAttempt}: {notificationDebug.timestamp}
                  </p>
                  <p className="note">
                    {dictionary.appShell.notificationDebugLastResult}:{" "}
                    {dictionary.appShell.notificationResults[notificationDebug.result]}
                  </p>
                  <p className="note">
                    {dictionary.appShell.notificationDebugSkipReason}:{" "}
                    {dictionary.appShell.notificationSkipReasons[notificationDebug.skipReason]}
                  </p>
                  <p className="note">
                    {dictionary.appShell.notificationDebugEvent}: {notificationDebug.eventType}
                  </p>
                  <p className="note">
                    {dictionary.appShell.notificationDebugMessageId}: {notificationDebug.messageId}
                  </p>
                  <p className="note">
                    {dictionary.appShell.notificationDebugSenderCurrent}: {notificationDebug.senderUserId} /{" "}
                    {notificationDebug.currentUserId}
                  </p>
                  <p className="note">
                    {dictionary.appShell.notificationDebugSelectedChat}: {notificationDebug.selectedChatId}
                  </p>
                  <p className="note">
                    {dictionary.appShell.notificationDebugAttempted}:{" "}
                    {notificationDebug.attempted ? dictionary.appShell.yes : dictionary.appShell.no}
                  </p>
                  {notificationDebug.error ? (
                    <p className="form-error">
                      {dictionary.appShell.notificationDebugError}: {notificationDebug.error}
                    </p>
                  ) : null}
                </div>
              </div>
              <div className="settings-menu-group">
                <Link className="secondary-link" href={`/${locale}/about`}>
                  {dictionary.appShell.about}
                </Link>
              </div>
              <div className="settings-menu-group settings-menu-logout">
                <button className="secondary-link" onClick={() => void logout()} type="button">
                  {dictionary.dashboard.logout}
                </button>
              </div>
              <p className="note">{dictionary.appShell.settingsNote}</p>
              <p className="note">
                {officeChatBrand.productName} · {officeChatBrand.version || "development"}
              </p>
            </div>
          </section>
          {isNotificationGuideOpen ? (
            <section className="settings-panel notification-guide-panel" aria-label={dictionary.appShell.notificationGuide.title}>
              <div className="dashboard-header">
                <h2 className="section-title">{dictionary.appShell.notificationGuide.title}</h2>
                <button className="table-action" onClick={() => setIsNotificationGuideOpen(false)} type="button">
                  {dictionary.appShell.notificationGuide.close}
                </button>
              </div>
              <div className="notification-guide-content">
                <section>
                  <h3>{dictionary.appShell.notificationGuide.officeChatTitle}</h3>
                  <ul>
                    {dictionary.appShell.notificationGuide.officeChatSteps.map((step) => (
                      <li key={step}>{step}</li>
                    ))}
                  </ul>
                </section>
                <section>
                  <h3>{dictionary.appShell.notificationGuide.browserTitle}</h3>
                  <p>{dictionary.appShell.notificationGuide.chromeEdge}</p>
                  <p>{dictionary.appShell.notificationGuide.chromeEdgeSettings}</p>
                  <p>{dictionary.appShell.notificationGuide.firefox}</p>
                </section>
                <section>
                  <h3>{dictionary.appShell.notificationGuide.windowsTitle}</h3>
                  <ul>
                    {dictionary.appShell.notificationGuide.windowsSteps.map((step) => (
                      <li key={step}>{step}</li>
                    ))}
                  </ul>
                </section>
                <section>
                  <h3>{dictionary.appShell.notificationGuide.linuxTitle}</h3>
                  <ul>
                    {dictionary.appShell.notificationGuide.linuxSteps.map((step) => (
                      <li key={step}>{step}</li>
                    ))}
                  </ul>
                </section>
                <section>
                  <h3>{dictionary.appShell.notificationGuide.limitationsTitle}</h3>
                  <ul>
                    {dictionary.appShell.notificationGuide.limitations.map((item) => (
                      <li key={item}>{item}</li>
                    ))}
                  </ul>
                </section>
              </div>
            </section>
          ) : null}
          </div>
        </div>
      ) : null}
    </main>
  );
}
