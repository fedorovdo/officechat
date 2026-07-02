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

import {
  clearStoredAccessToken,
  createDirectConversation,
  createDiscussion,
  deleteMyAvatar,
  getCurrentUser,
  getDirectConversations,
  getDirectWebSocketUrl,
  getGroups,
  getGroupMembers,
  getGroupMessages,
  getGroupWebSocketUrl,
  getPersonalWebSocketUrl,
  getStoredAccessToken,
  getUsers,
  isAdminRole,
  uploadMyAvatar,
  updateCurrentUser,
  type DirectMessageEvent,
  type GroupMessageEvent,
  type OfficeChatDirectoryUser,
  type OfficeChatDirectConversation,
  type OfficeChatDirectMessage,
  type OfficeChatDiscussionMessage,
  type OfficeChatGroup,
  type OfficeChatGroupMember,
  type OfficeChatMessage,
  type OfficeChatUser,
  type PersonalNotificationEvent
} from "../lib/api";
import type { Dictionary, Locale } from "../lib/i18n";
import { DirectChatPanel } from "./DirectChatPanel";
import { DiscussionPanel } from "./DiscussionPanel";
import { GroupChatPanel } from "./GroupChatPanel";
import { UserAvatar } from "./UserAvatar";

type UserAppShellProps = {
  dictionary: Dictionary;
  locale: Locale;
};

type SidebarSide = "left" | "right";
type AppFontSize = "small" | "normal" | "large";
type AccentColor = "default" | "blue" | "green" | "purple" | "forest";
type SidebarTab = "all" | "groups" | "direct";
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
  const notifiedMessageIdsRef = useRef<string[]>([]);
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
  const [personalSocketStatus, setPersonalSocketStatus] = useState<PersonalSocketStatus>("disconnected");
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [isProfileOpen, setIsProfileOpen] = useState(false);
  const [isNotificationGuideOpen, setIsNotificationGuideOpen] = useState(false);
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

  const selectedGroup = selected.type === "group" ? groups.find((group) => group.id === selected.groupId) : null;
  const selectedDirectConversation =
    selected.type === "direct"
      ? directConversations.find((conversation) => conversation.id === selected.conversationId)
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
    if (message.attachments.length > 0) return `📎 ${message.attachments[0].original_filename}`;
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
    const token = getStoredAccessToken();
    if (!token) {
      router.replace(`/${locale}/login`);
      return;
    }
    setError("");
    try {
      const discussion = await createDiscussion(token, message.group_id, message.id);
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
          if (payload.type === "message.reactions.updated" || !payload.type.startsWith("message.")) {
            return;
          }
          const isSelectedGroup = selected.type === "group" && selected.groupId === payload.group_id;
          const isOwnMessage = payload.message.sender_user_id === currentUser.id;
          const isMentioned = payload.message.mentions.some((mention) => mention.user_id === currentUser.id);
          updateGroupActivity(
            payload.group_id,
            payload.message,
            !isSelectedGroup && !isOwnMessage,
            isMentioned && !isSelectedGroup && !isOwnMessage
          );
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

    // Conversation-specific sockets keep known direct-chat sidebar previews fresh; /api/ws/me handles global notifications.
    const token = getStoredAccessToken();
    if (!token) {
      return;
    }

    const sockets = directConversations.map((conversation) => {
      const websocket = new WebSocket(getDirectWebSocketUrl(token, conversation.id));
      websocket.onmessage = (event) => {
        try {
          const payload = JSON.parse(event.data as string) as DirectMessageEvent;
          if (payload.type === "direct.message.reactions.updated" || !payload.type.startsWith("direct.message.")) {
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
    const activeUser = currentUser;

    const token = getStoredAccessToken();
    if (!token) {
      return;
    }
    const accessToken = token;

    let websocket: WebSocket | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let shouldReconnect = true;
    let reconnectAttempts = 0;
    const maxReconnectAttempts = 10;

    function scheduleReconnect() {
      if (!shouldReconnect) {
        return;
      }
      if (reconnectAttempts >= maxReconnectAttempts) {
        setPersonalSocketStatus("disconnected");
        return;
      }

      reconnectAttempts += 1;
      setPersonalSocketStatus("reconnecting");
      reconnectTimer = setTimeout(connect, 3000);
    }

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

    function connect() {
      websocket = new WebSocket(getPersonalWebSocketUrl(accessToken));
      websocket.onopen = () => {
        reconnectAttempts = 0;
        setPersonalSocketStatus("connected");
      };
      websocket.onmessage = (event) => {
        try {
          const payload = JSON.parse(event.data as string) as PersonalNotificationEvent;
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
      };
      websocket.onclose = () => {
        websocket = null;
        scheduleReconnect();
      };
      websocket.onerror = () => {
        websocket?.close();
      };
    }

    connect();

    return () => {
      shouldReconnect = false;
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
      }
      websocket?.close();
      setPersonalSocketStatus("disconnected");
    };
  }, [
    currentUser,
    dictionary.discussions.newMessageNotification,
    dictionary.messages.deletedMessage,
    dictionary.messages.mentionedYou,
    updateDirectUserActivity,
    updateGroupActivity
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
    // TODO: Move notification preferences to backend user_preferences when user settings are persisted server-side.
    localStorage.setItem(notificationPreferenceKey, String(isEnabled));
    setNotificationPreferenceRaw(String(isEnabled));
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
      setActiveDiscussionId(null);
    } catch (caughtError) {
      setError(caughtError instanceof Error && caughtError.name !== "AbortError" ? caughtError.message : dictionary.appShell.loadError);
    } finally {
      clearTimeout(timeout);
      setPendingDirectUsername(null);
    }
  }

  function getInitials(value: string) {
    const parts = value.trim().split(/\s+/).filter(Boolean);
    return (parts.length > 1 ? `${parts[0][0]}${parts[1][0]}` : parts[0]?.slice(0, 2) || "OC").toUpperCase();
  }

  function closeChatOnSmallScreen() {
    setSelected({ type: "empty" });
    setActiveDiscussionId(null);
  }

  return (
    <main className={appShellClass} style={appShellStyle}>
      <div className="user-app-layout">
        <aside className="user-app-sidebar" aria-label={dictionary.appShell.sidebarAriaLabel}>
          <div className="messenger-sidebar-header">
            <div className="messenger-brand">
              <span className="messenger-brand-mark" aria-hidden="true">OC</span>
              <span className="messenger-brand-copy">
                <strong>{dictionary.app.name}</strong>
                <small>{dictionary.appShell.title}</small>
              </span>
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
            <input
              aria-label={dictionary.appShell.sidebarSearch}
              className="field-input user-app-sidebar-search"
              onChange={(event) => setSidebarSearch(event.target.value)}
              placeholder={dictionary.appShell.sidebarSearch}
              type="search"
              value={sidebarSearch}
            />
            <div className="sidebar-tabs" role="tablist" aria-label={dictionary.appShell.chatTabs}>
              {(["all", "groups", "direct"] as SidebarTab[]).map((tab) => (
                <button
                  aria-selected={sidebarTab === tab}
                  className={sidebarTab === tab ? "sidebar-tab sidebar-tab-active" : "sidebar-tab"}
                  key={tab}
                  onClick={() => setActiveSidebarTab(tab)}
                  role="tab"
                  type="button"
                >
                  {dictionary.appShell.tabs[tab]}
                </button>
              ))}
            </div>
          </div>

          <div className="user-app-nav-list">
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
              const itemClassName = [
                "user-app-nav-item",
                isSelected ? "user-app-nav-item-active" : "",
                activity?.unread ? "user-app-nav-item-unread" : "",
                activity?.mentioned ? "user-app-nav-item-mentioned" : ""
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
                    <UserAvatar user={item.user} size={40} />
                  )}
                  <span className="sidebar-item-content">
                    <span className="sidebar-item-top">
                      <strong>{name}</strong>
                      {activity?.timestamp ? <span className="sidebar-item-time">{formatActivityTime(activity.timestamp)}</span> : null}
                    </span>
                    <span className="sidebar-item-preview">{activity?.preview || dictionary.sidebarActivity.noRecentMessages}</span>
                    <span className="sidebar-item-meta">{secondary}</span>
                  </span>
                  {activity?.unread ? (
                    <span
                      aria-label={dictionary.sidebarActivity.unread}
                      className={activity.mentioned ? "sidebar-unread-dot sidebar-unread-dot-mention" : "sidebar-unread-dot"}
                      title={activity.mentioned ? dictionary.messages.mentions : dictionary.sidebarActivity.newMessages}
                    />
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
                <Link
                  aria-label={dictionary.appShell.admin}
                  className="sidebar-icon-button"
                  href={`/${locale}/admin/users`}
                  title={dictionary.appShell.admin}
                >
                  A
                </Link>
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
                />
              </div>
              {activeDiscussionId ? (
                <DiscussionPanel
                  currentUser={currentUser}
                  dictionary={dictionary}
                  discussionId={activeDiscussionId}
                  locale={locale}
                  onClose={() => setActiveDiscussionId(null)}
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
                    <p className="admin-current">
                      @{selectedDirectConversation.other_user.username} · {dictionary.appShell.onlineStatusPlaceholder}
                    </p>
                  </div>
                </div>
              </div>
              <DirectChatPanel
                conversation={selectedDirectConversation}
                currentUser={currentUser}
                dictionary={dictionary}
                locale={locale}
              />
            </div>
          ) : null}
        </section>
      </div>

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
              <p className="note">{dictionary.appShell.settingsNote}</p>
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
