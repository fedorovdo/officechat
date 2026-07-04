import {
  clearStoredAccessToken,
  expireAuthentication,
  getStoredAccessToken,
  requireStoredAccessToken,
  storeAccessToken
} from "./session";

export type UserRole = "superadmin" | "admin" | "group_owner" | "moderator" | "user" | "bot";
export type GroupRole = "owner" | "moderator" | "member";
export type DiscussionMemberRole = "owner" | "member";

export type OfficeChatUser = {
  id: string;
  username: string;
  display_name: string;
  email: string | null;
  role: UserRole;
  is_active: boolean;
  is_system: boolean;
  auth_provider: string;
  avatar_url: string | null;
  created_at: string;
  updated_at: string;
  last_login_at: string | null;
  last_seen_at: string | null;
};

export type OfficeChatDirectoryUser = {
  id: string;
  username: string;
  display_name: string;
  role: UserRole;
  is_active: boolean;
  avatar_url: string | null;
  last_seen_at: string | null;
};

export type OfficeChatPresence = {
  user_id: string;
  status: "online" | "offline";
  last_seen_at: string | null;
};

export type TypingEvent = {
  type: "typing.updated";
  user_id: string;
  display_name: string;
  is_typing: boolean;
};

export type ChatType = "group" | "direct" | "discussion";

export type OfficeChatUnreadChat = {
  chat_type: ChatType;
  chat_id: string;
  unread_count: number;
  mention_count: number;
  first_unread_message_id: string | null;
  newest_unread_message_id: string | null;
};

export type OfficeChatUnreadSummary = {
  total: number;
  groups: number;
  direct: number;
  discussions: number;
  chats: OfficeChatUnreadChat[];
};

export type OfficeChatReadState = {
  chat_type: ChatType;
  chat_id: string;
  last_read_message_id: string | null;
  first_unread_message_id?: string | null;
  newest_unread_message_id?: string | null;
  last_read_message_created_at: string | null;
  last_read_at: string | null;
  unread_count: number;
  mention_count: number;
  total_unread: number;
};

export type OfficeChatDirectReadReceipt = {
  conversation_id: string;
  reader_user_id: string;
  last_read_message_id: string | null;
  last_read_message_created_at: string | null;
  read_at: string | null;
};

export type UnreadEvent = {
  type: "unread.updated";
  chat_type: ChatType;
  chat_id: string;
  unread_count: number;
  mention_count: number;
  total_unread: number | null;
  last_read_message_id: string | null;
  first_unread_message_id?: string | null;
  newest_unread_message_id?: string | null;
  removed?: boolean;
};

export type DirectReadEvent = {
  type: "direct.read";
  conversation_id: string;
  reader_user_id: string;
  last_read_message_id: string | null;
  last_read_message_created_at: string | null;
  read_at: string | null;
};

export type CreateAdminUserPayload = {
  username: string;
  display_name: string;
  email?: string | null;
  password: string;
  role: UserRole;
  is_active: boolean;
};

export type UpdateAdminUserPayload = {
  display_name: string;
  email?: string | null;
  role: UserRole;
  is_active: boolean;
};

export type OfficeChatGroup = {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  is_private: boolean;
  is_system: boolean;
  is_active: boolean;
  created_by_user_id: string | null;
  created_at: string;
  updated_at: string;
};

export type OfficeChatGroupMember = {
  id: string;
  group_id: string;
  user_id: string;
  role: GroupRole;
  joined_at: string;
  user: OfficeChatUser;
};

export type OfficeChatReactionUser = {
  id: string;
  username: string;
  display_name: string;
};

export type OfficeChatMessageReaction = {
  emoji: string;
  count: number;
  reacted_by_me: boolean;
  users: OfficeChatReactionUser[];
};

export type OfficeChatMessage = {
  id: string;
  group_id: string;
  sender_user_id: string;
  reply_to_message_id: string | null;
  body: string;
  message_type: string;
  is_deleted: boolean;
  is_archived: boolean;
  archived_at: string | null;
  edited_at: string | null;
  created_at: string;
  updated_at: string;
  sender: OfficeChatUser;
  reply_to: OfficeChatMessageReplyPreview | null;
  attachments: OfficeChatMessageAttachment[];
  mentions: OfficeChatMessageMention[];
  reactions: OfficeChatMessageReaction[];
};

export type OfficeChatAttachment = {
  id: string;
  original_filename: string;
  content_type: string | null;
  size_bytes: number;
  created_at: string;
  download_url: string;
  file_available: boolean;
  file_deleted_at: string | null;
};

export type OfficeChatMessageReplyPreview = {
  id: string;
  sender: Pick<OfficeChatUser, "id" | "username" | "display_name">;
  body_preview: string;
  is_deleted: boolean;
  is_archived: boolean;
  archived_at: string | null;
  created_at: string;
  attachment_count: number;
};

export type OfficeChatMessageAttachment = OfficeChatAttachment & {
  group_id: string;
};

export type OfficeChatMessageMention = {
  user_id: string;
  username: string;
  display_name: string;
};

export type OfficeChatDirectMessage = {
  id: string;
  conversation_id: string;
  sender_user_id: string;
  reply_to_message_id: string | null;
  body: string;
  message_type: string;
  is_deleted: boolean;
  is_archived: boolean;
  archived_at: string | null;
  edited_at: string | null;
  created_at: string;
  updated_at: string;
  sender: OfficeChatDirectoryUser;
  reply_to: OfficeChatDirectMessageReplyPreview | null;
  attachments: OfficeChatAttachment[];
  reactions: OfficeChatMessageReaction[];
};

export type OfficeChatDirectMessageReplyPreview = {
  id: string;
  sender: Pick<OfficeChatDirectoryUser, "id" | "username" | "display_name">;
  body_preview: string;
  is_deleted: boolean;
  is_archived: boolean;
  archived_at: string | null;
  created_at: string;
  attachment_count: number;
};

export type OfficeChatDirectConversation = {
  id: string;
  user_one_id: string;
  user_two_id: string;
  created_at: string;
  updated_at: string;
  other_user: OfficeChatDirectoryUser;
  last_message: OfficeChatDirectMessage | null;
};

export type OfficeChatDiscussionSourceMessage = {
  id: string;
  sender: OfficeChatDirectoryUser;
  body_preview: string;
  is_deleted: boolean;
  created_at: string;
};

export type OfficeChatDiscussionMember = {
  id: string;
  discussion_id: string;
  user_id: string;
  role: DiscussionMemberRole;
  joined_at: string;
  user: OfficeChatDirectoryUser;
};

export type OfficeChatDiscussion = {
  id: string;
  source_group_id: string;
  source_message_id: string;
  title: string | null;
  created_by_user_id: string;
  is_active: boolean;
  created_at: string;
  updated_at: string;
  source_message: OfficeChatDiscussionSourceMessage;
  members: OfficeChatDiscussionMember[];
  can_manage_members: boolean;
};

export type OfficeChatDiscussionMessage = {
  id: string;
  discussion_id: string;
  sender_user_id: string;
  body: string;
  is_deleted: boolean;
  is_archived: boolean;
  archived_at: string | null;
  edited_at: string | null;
  created_at: string;
  updated_at: string;
  sender: OfficeChatDirectoryUser;
  attachments: OfficeChatAttachment[];
  reactions: OfficeChatMessageReaction[];
};

export type OfficeChatBot = {
  id: string;
  user_id: string;
  name: string;
  description: string | null;
  token_preview: string;
  is_active: boolean;
  created_by_user_id: string | null;
  created_at: string;
  updated_at: string;
  last_used_at: string | null;
  user: OfficeChatUser;
};

export type CreateAdminBotPayload = {
  name: string;
  description?: string | null;
};

export type UpdateAdminBotPayload = {
  name?: string;
  description?: string | null;
  is_active?: boolean;
};

export type OfficeChatBotTokenResponse = OfficeChatBot & {
  token: string;
};

export type OfficeChatBotRotateTokenResponse = {
  bot: OfficeChatBot;
  token: string;
};

export type GroupMessageEvent =
  | {
      type: "message.created" | "message.updated" | "message.deleted";
      group_id: string;
      message: OfficeChatMessage;
      message_id?: string;
    }
  | {
      type: "message.reactions.updated";
      group_id: string;
      message_id: string;
      reactions: OfficeChatMessageReaction[];
    }
  | TypingEvent;

export type DirectMessageEvent =
  | {
      type: "direct.message.created" | "direct.message.updated" | "direct.message.deleted";
      conversation_id: string;
      message: OfficeChatDirectMessage;
      message_id?: string;
    }
  | {
      type: "direct.message.reactions.updated";
      conversation_id: string;
      message_id: string;
      reactions: OfficeChatMessageReaction[];
    }
  | TypingEvent
  | DirectReadEvent;

export type DiscussionEvent =
  | {
      type: "discussion.message.created" | "discussion.message.updated" | "discussion.message.deleted";
      discussion_id: string;
      message: OfficeChatDiscussionMessage;
      message_id?: string;
    }
  | {
      type: "discussion.member.added";
      discussion_id: string;
      member: OfficeChatDiscussionMember;
    }
  | {
      type: "discussion.member.removed";
      discussion_id: string;
      member_id: string;
    }
  | {
      type: "discussion.message.reactions.updated";
      discussion_id: string;
      message_id: string;
      reactions: OfficeChatMessageReaction[];
    }
  | TypingEvent;

export type PersonalNotificationEvent =
  | {
      type: "user.group.message.created";
      group_id: string;
      group: Pick<OfficeChatGroup, "id" | "name" | "slug">;
      message: OfficeChatMessage;
      mentioned_user_ids: string[];
    }
  | {
      type: "user.direct.message.created";
      conversation_id: string;
      other_user: OfficeChatDirectoryUser;
      message: OfficeChatDirectMessage;
    }
  | {
      type: "user.discussion.message.created";
      discussion_id: string;
      discussion: Pick<OfficeChatDiscussion, "id" | "title" | "source_group_id">;
      message: OfficeChatDiscussionMessage;
    }
  | {
      type: "presence.updated";
      user_id: string;
      status: "online" | "offline";
      last_seen_at: string | null;
    }
  | UnreadEvent
  | { type: "unread.refresh" };

export type CreateGroupPayload = {
  name: string;
  slug: string;
  description?: string | null;
  is_private: boolean;
  is_active: boolean;
};

export type UpdateGroupPayload = {
  name: string;
  description?: string | null;
  is_private: boolean;
  is_active: boolean;
};

export type AddGroupMemberPayload = {
  username?: string;
  user_id?: string;
  role: GroupRole;
};

export type RetentionSettings = {
  retention_enabled: boolean;
  active_history_days: number;
  archive_enabled: boolean;
  attachment_retention_days: number | null;
  delete_archived_after_days: number | null;
  cleanup_batch_size: number;
  cleanup_interval_hours: number;
  last_cleanup_started_at: string | null;
  last_cleanup_finished_at: string | null;
  last_cleanup_status: string | null;
  last_cleanup_summary: RetentionSummary | null;
  updated_at: string;
  updated_by_user_id: string | null;
};

export type RetentionSettingsUpdate = Pick<
  RetentionSettings,
  | "retention_enabled"
  | "active_history_days"
  | "archive_enabled"
  | "attachment_retention_days"
  | "delete_archived_after_days"
  | "cleanup_batch_size"
  | "cleanup_interval_hours"
>;

export type RetentionSummary = {
  group_messages_archived: number;
  direct_messages_archived: number;
  discussion_messages_archived: number;
  attachments_deleted: number;
  files_missing: number;
  errors: string[];
};

export type RetentionRunResult = {
  dry_run: boolean;
  status: string;
  summary: RetentionSummary;
};

export type StorageStats = {
  uploads_total_bytes: number;
  avatar_bytes: number;
  group_attachment_bytes: number;
  direct_attachment_bytes: number;
  discussion_attachment_bytes: number;
  attachment_count: number;
  missing_file_count: number;
  message_counts: { active: number; archived: number; soft_deleted: number };
  oldest_active_message_at: string | null;
  oldest_archived_message_at: string | null;
};

export type AuditEvent = {
  id: string;
  actor_user_id: string | null;
  actor_username: string | null;
  actor_display_name: string | null;
  actor_role: string | null;
  event_type: string;
  category: string;
  action: string;
  status: string;
  target_type: string | null;
  target_id: string | null;
  target_label: string | null;
  source_ip: string | null;
  user_agent: string | null;
  request_id: string | null;
  details: Record<string, unknown> | null;
  error_code: string | null;
  error_message: string | null;
  created_at: string;
};

export type AuditEventPage = { items: AuditEvent[]; total: number; page: number; limit: number };
export type AuditFilterOptions = { categories: string[]; statuses: string[]; event_types: string[] };
export type AuditQuery = {
  page?: number;
  limit?: number;
  date_from?: string;
  date_to?: string;
  actor_username?: string;
  category?: string;
  event_type?: string;
  status?: string;
  target_type?: string;
  target_id?: string;
  search?: string;
};

const apiBaseUrl = process.env.NEXT_PUBLIC_BACKEND_URL ?? "http://localhost:8100";

// TODO: Move production auth storage to secure cookies or a stronger session mechanism.
export { clearStoredAccessToken, getStoredAccessToken, requireStoredAccessToken, storeAccessToken };

export class AuthenticationError extends Error {}
export class PermissionError extends Error {}
export class BackendUnavailableError extends Error {}
export class ApiResponseError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
  }
}

export function getLocalizedApiError(
  error: unknown,
  messages: {
    expired: string;
    serverUnavailable: string;
    loadError: string;
    accessDenied: string;
  }
) {
  if (error instanceof AuthenticationError) return messages.expired;
  if (error instanceof PermissionError) return messages.accessDenied;
  if (error instanceof BackendUnavailableError) return messages.serverUnavailable;
  if (error instanceof ApiResponseError && error.status >= 500) return messages.loadError;
  return error instanceof Error && error.message !== "Failed to fetch" ? error.message : messages.loadError;
}

async function authenticatedFetch(url: string, token: string, init: RequestInit = {}) {
  let response: Response;
  try {
    response = await fetch(url, init);
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") throw error;
    throw new BackendUnavailableError("Server is unavailable", { cause: error });
  }
  if (response.status === 401) {
    expireAuthentication("expired");
    throw new AuthenticationError("Your session has expired. Please sign in again.");
  }
  if (response.status === 403) {
    const body = (await response.clone().json().catch(() => null)) as { detail?: unknown } | null;
    throw new PermissionError(typeof body?.detail === "string" ? body.detail : "Access denied");
  }
  return response;
}

async function apiFetch<T>(path: string, token: string, init: RequestInit = {}): Promise<T> {
  const response = await authenticatedFetch(`${apiBaseUrl}${path}`, token, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
      ...init.headers
    }
  });

  if (!response.ok) {
    let message = response.statusText;
    try {
      const body = (await response.json()) as { detail?: unknown };
      if (typeof body.detail === "string") {
        message = body.detail;
      }
    } catch {
      message = response.statusText;
    }
    throw new ApiResponseError(response.status, message);
  }

  if (response.status === 204) {
    return undefined as T;
  }

  return (await response.json()) as T;
}

async function uploadMessageWithAttachment<T>(
  path: string,
  token: string,
  body: string,
  file: File,
  replyToMessageId?: string | null,
  signal?: AbortSignal
) {
  const formData = new FormData();
  formData.append("file", file);
  if (body.trim()) {
    formData.append("body", body);
  }
  if (replyToMessageId) {
    formData.append("reply_to_message_id", replyToMessageId);
  }

  const response = await authenticatedFetch(`${apiBaseUrl}${path}`, token, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
    body: formData,
    signal
  });
  if (!response.ok) {
    let message = response.statusText;
    try {
      const responseBody = (await response.json()) as { detail?: unknown };
      if (typeof responseBody.detail === "string") {
        message = responseBody.detail;
      }
    } catch {
      message = response.statusText;
    }
    throw new ApiResponseError(response.status, message);
  }
  return (await response.json()) as T;
}

async function uploadMessageWithAttachments<T>(
  path: string,
  token: string,
  body: string,
  files: File[],
  replyToMessageId?: string | null,
  signal?: AbortSignal
) {
  const formData = new FormData();
  files.forEach((file) => formData.append("files", file));
  if (body.trim()) formData.append("body", body);
  if (replyToMessageId) formData.append("reply_to_message_id", replyToMessageId);

  const response = await authenticatedFetch(`${apiBaseUrl}${path}`, token, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
    body: formData,
    signal
  });
  if (!response.ok) {
    const responseBody = (await response.json().catch(() => null)) as { detail?: unknown } | null;
    throw new ApiResponseError(
      response.status,
      typeof responseBody?.detail === "string" ? responseBody.detail : response.statusText
    );
  }
  return (await response.json()) as T;
}

export function getCurrentUser(token: string) {
  return apiFetch<OfficeChatUser>("/api/auth/me", token);
}

export function updateCurrentUser(token: string, displayName: string) {
  return apiFetch<OfficeChatUser>("/api/auth/me", token, {
    method: "PATCH",
    body: JSON.stringify({ display_name: displayName })
  });
}

export async function uploadMyAvatar(token: string, file: File) {
  const formData = new FormData();
  formData.append("file", file);
  const response = await authenticatedFetch(`${apiBaseUrl}/api/auth/me/avatar`, token, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
    body: formData
  });
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as { detail?: unknown } | null;
    throw new ApiResponseError(response.status, typeof body?.detail === "string" ? body.detail : response.statusText);
  }
  return (await response.json()) as OfficeChatUser;
}

export function deleteMyAvatar(token: string) {
  return apiFetch<OfficeChatUser>("/api/auth/me/avatar", token, { method: "DELETE" });
}

export function buildUserAvatarUrl(avatarUrl: string) {
  return `${apiBaseUrl}${avatarUrl}`;
}

export async function fetchUserAvatar(token: string, avatarUrl: string) {
  const response = await authenticatedFetch(buildUserAvatarUrl(avatarUrl), token, {
    headers: { Authorization: `Bearer ${token}` }
  });
  if (!response.ok) {
    throw new ApiResponseError(response.status, response.statusText);
  }
  return response.blob();
}

export function getAdminUsers(token: string) {
  return apiFetch<OfficeChatUser[]>("/api/admin/users", token);
}

export function getRetentionSettings(token: string) {
  return apiFetch<RetentionSettings>("/api/admin/retention/settings", token);
}

function buildAuditQuery(query: AuditQuery) {
  const params = new URLSearchParams();
  Object.entries(query).forEach(([key, value]) => {
    if (value !== undefined && value !== "") params.set(key, String(value));
  });
  return params.toString();
}

export function getAuditEvents(token: string, query: AuditQuery = {}) {
  return apiFetch<AuditEventPage>(`/api/admin/audit/events?${buildAuditQuery(query)}`, token);
}

export function getAuditEvent(token: string, eventId: string) {
  return apiFetch<AuditEvent>(`/api/admin/audit/events/${eventId}`, token);
}

export function getAuditFilters(token: string) {
  return apiFetch<AuditFilterOptions>("/api/admin/audit/filters", token);
}

export async function downloadAuditCsv(token: string, query: AuditQuery = {}) {
  const response = await authenticatedFetch(
    `${apiBaseUrl}/api/admin/audit/export.csv?${buildAuditQuery(query)}`,
    token,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  if (!response.ok) throw new ApiResponseError(response.status, response.statusText);
  return response.blob();
}

export function updateRetentionSettings(token: string, payload: RetentionSettingsUpdate) {
  return apiFetch<RetentionSettings>("/api/admin/retention/settings", token, {
    method: "PATCH",
    body: JSON.stringify(payload)
  });
}

export function previewRetentionCleanup(token: string) {
  return apiFetch<RetentionRunResult>("/api/admin/retention/dry-run", token, { method: "POST" });
}

export function runRetentionCleanup(token: string) {
  return apiFetch<RetentionRunResult>("/api/admin/retention/run", token, {
    method: "POST",
    body: JSON.stringify({ confirm: true })
  });
}

export function getStorageStats(token: string) {
  return apiFetch<StorageStats>("/api/admin/storage/stats", token);
}

export function getUsers(token: string) {
  return apiFetch<OfficeChatDirectoryUser[]>("/api/users", token);
}

export function getUnreadSummary(token: string) {
  return apiFetch<OfficeChatUnreadSummary>("/api/unread", token);
}

export function markChatRead(token: string, chatType: ChatType, chatId: string, messageId: string) {
  return apiFetch<OfficeChatReadState>("/api/read-state", token, {
    method: "POST",
    body: JSON.stringify({ chat_type: chatType, chat_id: chatId, message_id: messageId })
  });
}

export function getDirectReadReceipt(token: string, conversationId: string) {
  return apiFetch<OfficeChatDirectReadReceipt>(`/api/read-state/direct/${conversationId}/receipt`, token);
}

export function getPresence(token: string, userIds: string[]) {
  const query = new URLSearchParams();
  for (const userId of Array.from(new Set(userIds)).slice(0, 100)) {
    query.append("user_ids", userId);
  }
  return apiFetch<OfficeChatPresence[]>(`/api/presence?${query.toString()}`, token);
}

export function createAdminUser(token: string, payload: CreateAdminUserPayload) {
  return apiFetch<OfficeChatUser>("/api/admin/users", token, {
    method: "POST",
    body: JSON.stringify(payload)
  });
}

export function updateAdminUser(token: string, userId: string, payload: UpdateAdminUserPayload) {
  return apiFetch<OfficeChatUser>(`/api/admin/users/${userId}`, token, {
    method: "PATCH",
    body: JSON.stringify(payload)
  });
}

export function resetAdminUserPassword(token: string, userId: string, newPassword: string) {
  return apiFetch<OfficeChatUser>(`/api/admin/users/${userId}/reset-password`, token, {
    method: "POST",
    body: JSON.stringify({ new_password: newPassword })
  });
}

export function getAdminBots(token: string) {
  return apiFetch<OfficeChatBot[]>("/api/admin/bots", token);
}

export function createAdminBot(token: string, payload: CreateAdminBotPayload) {
  return apiFetch<OfficeChatBotTokenResponse>("/api/admin/bots", token, {
    method: "POST",
    body: JSON.stringify(payload)
  });
}

export function updateAdminBot(token: string, botId: string, payload: UpdateAdminBotPayload) {
  return apiFetch<OfficeChatBot>(`/api/admin/bots/${botId}`, token, {
    method: "PATCH",
    body: JSON.stringify(payload)
  });
}

export function rotateAdminBotToken(token: string, botId: string) {
  return apiFetch<OfficeChatBotRotateTokenResponse>(`/api/admin/bots/${botId}/rotate-token`, token, {
    method: "POST"
  });
}

export function isAdminRole(role: string) {
  return role === "superadmin" || role === "admin";
}

export function getGroups(token: string, includeInactive = false) {
  const query = includeInactive ? "?include_inactive=true" : "";
  return apiFetch<OfficeChatGroup[]>(`/api/groups${query}`, token);
}

export function createGroup(token: string, payload: CreateGroupPayload) {
  return apiFetch<OfficeChatGroup>("/api/groups", token, {
    method: "POST",
    body: JSON.stringify(payload)
  });
}

export function getGroup(token: string, groupId: string) {
  return apiFetch<OfficeChatGroup>(`/api/groups/${groupId}`, token);
}

export function updateGroup(token: string, groupId: string, payload: UpdateGroupPayload) {
  return apiFetch<OfficeChatGroup>(`/api/groups/${groupId}`, token, {
    method: "PATCH",
    body: JSON.stringify(payload)
  });
}

export function getGroupMembers(token: string, groupId: string) {
  return apiFetch<OfficeChatGroupMember[]>(`/api/groups/${groupId}/members`, token);
}

export function addGroupMember(token: string, groupId: string, payload: AddGroupMemberPayload) {
  return apiFetch<OfficeChatGroupMember>(`/api/groups/${groupId}/members`, token, {
    method: "POST",
    body: JSON.stringify(payload)
  });
}

export function updateGroupMember(token: string, groupId: string, memberId: string, role: GroupRole) {
  return apiFetch<OfficeChatGroupMember>(`/api/groups/${groupId}/members/${memberId}`, token, {
    method: "PATCH",
    body: JSON.stringify({ role })
  });
}

export function removeGroupMember(token: string, groupId: string, memberId: string) {
  return apiFetch<void>(`/api/groups/${groupId}/members/${memberId}`, token, {
    method: "DELETE"
  });
}

export function getGroupMessages(token: string, groupId: string, limit = 50) {
  return apiFetch<OfficeChatMessage[]>(`/api/groups/${groupId}/messages?limit=${limit}`, token);
}

export function getArchivedGroupMessages(token: string, groupId: string, limit = 50, before?: string) {
  const query = new URLSearchParams({ limit: String(limit) });
  if (before) query.set("before", before);
  return apiFetch<OfficeChatMessage[]>(`/api/groups/${groupId}/messages/archive?${query}`, token);
}

export function sendGroupMessage(token: string, groupId: string, body: string, replyToMessageId?: string | null) {
  return apiFetch<OfficeChatMessage>(`/api/groups/${groupId}/messages`, token, {
    method: "POST",
    body: JSON.stringify({ body, message_type: "text", reply_to_message_id: replyToMessageId ?? null })
  });
}

export async function sendGroupMessageWithAttachment(
  token: string,
  groupId: string,
  body: string,
  file: File,
  replyToMessageId?: string | null
) {
  return uploadMessageWithAttachment<OfficeChatMessage>(
    `/api/groups/${groupId}/messages/with-attachment`,
    token,
    body,
    file,
    replyToMessageId
  );
}

export function sendGroupMessageWithAttachments(
  token: string,
  groupId: string,
  body: string,
  files: File[],
  replyToMessageId?: string | null
) {
  return uploadMessageWithAttachments<OfficeChatMessage>(
    `/api/groups/${groupId}/messages/with-attachments`, token, body, files, replyToMessageId
  );
}

export function editGroupMessage(token: string, groupId: string, messageId: string, body: string) {
  return apiFetch<OfficeChatMessage>(`/api/groups/${groupId}/messages/${messageId}`, token, {
    method: "PATCH",
    body: JSON.stringify({ body })
  });
}

export function deleteGroupMessage(token: string, groupId: string, messageId: string) {
  return apiFetch<OfficeChatMessage>(`/api/groups/${groupId}/messages/${messageId}`, token, {
    method: "DELETE"
  });
}

export function addGroupMessageReaction(token: string, groupId: string, messageId: string, emoji: string) {
  return apiFetch<OfficeChatMessageReaction[]>(`/api/groups/${groupId}/messages/${messageId}/reactions`, token, {
    method: "PUT",
    body: JSON.stringify({ emoji })
  });
}

export function removeGroupMessageReaction(token: string, groupId: string, messageId: string, emoji: string) {
  return apiFetch<OfficeChatMessageReaction[]>(`/api/groups/${groupId}/messages/${messageId}/reactions`, token, {
    method: "DELETE",
    body: JSON.stringify({ emoji })
  });
}

export function getGroupWebSocketUrl(token: string, groupId: string) {
  const backendUrl = new URL(apiBaseUrl);
  backendUrl.protocol = backendUrl.protocol === "https:" ? "wss:" : "ws:";
  backendUrl.pathname = `/api/ws/groups/${groupId}`;
  // TODO: Move production WebSocket auth away from query tokens to a stronger session mechanism.
  backendUrl.search = new URLSearchParams({ token }).toString();
  return backendUrl.toString();
}

export function getDirectConversations(token: string) {
  return apiFetch<OfficeChatDirectConversation[]>("/api/direct/conversations", token);
}

export function createDirectConversation(token: string, username: string, signal?: AbortSignal) {
  return apiFetch<OfficeChatDirectConversation>("/api/direct/conversations", token, {
    method: "POST",
    signal,
    body: JSON.stringify({ username })
  });
}

export function getDirectMessages(token: string, conversationId: string, limit = 50) {
  return apiFetch<OfficeChatDirectMessage[]>(
    `/api/direct/conversations/${conversationId}/messages?limit=${limit}`,
    token
  );
}

export function getArchivedDirectMessages(token: string, conversationId: string, limit = 50, before?: string) {
  const query = new URLSearchParams({ limit: String(limit) });
  if (before) query.set("before", before);
  return apiFetch<OfficeChatDirectMessage[]>(
    `/api/direct/conversations/${conversationId}/messages/archive?${query}`,
    token
  );
}

export function sendDirectMessage(
  token: string,
  conversationId: string,
  body: string,
  signal?: AbortSignal,
  replyToMessageId?: string | null
) {
  return apiFetch<OfficeChatDirectMessage>(`/api/direct/conversations/${conversationId}/messages`, token, {
    method: "POST",
    signal,
    body: JSON.stringify({ body, message_type: "text", reply_to_message_id: replyToMessageId ?? null })
  });
}

export function sendDirectMessageWithAttachment(
  token: string,
  conversationId: string,
  body: string,
  file: File,
  signal?: AbortSignal,
  replyToMessageId?: string | null
) {
  return uploadMessageWithAttachment<OfficeChatDirectMessage>(
    `/api/direct/conversations/${conversationId}/messages/with-attachment`,
    token,
    body,
    file,
    replyToMessageId,
    signal
  );
}

export function sendDirectMessageWithAttachments(
  token: string,
  conversationId: string,
  body: string,
  files: File[],
  signal?: AbortSignal,
  replyToMessageId?: string | null
) {
  return uploadMessageWithAttachments<OfficeChatDirectMessage>(
    `/api/direct/conversations/${conversationId}/messages/with-attachments`,
    token,
    body,
    files,
    replyToMessageId,
    signal
  );
}

export function editDirectMessage(token: string, conversationId: string, messageId: string, body: string) {
  return apiFetch<OfficeChatDirectMessage>(
    `/api/direct/conversations/${conversationId}/messages/${messageId}`,
    token,
    {
      method: "PATCH",
      body: JSON.stringify({ body })
    }
  );
}

export function deleteDirectMessage(token: string, conversationId: string, messageId: string) {
  return apiFetch<OfficeChatDirectMessage>(
    `/api/direct/conversations/${conversationId}/messages/${messageId}`,
    token,
    {
      method: "DELETE"
    }
  );
}

export function addDirectMessageReaction(token: string, conversationId: string, messageId: string, emoji: string) {
  return apiFetch<OfficeChatMessageReaction[]>(
    `/api/direct/conversations/${conversationId}/messages/${messageId}/reactions`,
    token,
    { method: "PUT", body: JSON.stringify({ emoji }) }
  );
}

export function removeDirectMessageReaction(token: string, conversationId: string, messageId: string, emoji: string) {
  return apiFetch<OfficeChatMessageReaction[]>(
    `/api/direct/conversations/${conversationId}/messages/${messageId}/reactions`,
    token,
    { method: "DELETE", body: JSON.stringify({ emoji }) }
  );
}

export function getDirectWebSocketUrl(token: string, conversationId: string) {
  const backendUrl = new URL(apiBaseUrl);
  backendUrl.protocol = backendUrl.protocol === "https:" ? "wss:" : "ws:";
  backendUrl.pathname = `/api/ws/direct/${conversationId}`;
  // TODO: Move production WebSocket auth away from query tokens to a stronger session mechanism.
  backendUrl.search = new URLSearchParams({ token }).toString();
  return backendUrl.toString();
}

export function getPersonalWebSocketUrl(token: string) {
  const backendUrl = new URL(apiBaseUrl);
  backendUrl.protocol = backendUrl.protocol === "https:" ? "wss:" : "ws:";
  backendUrl.pathname = "/api/ws/me";
  // TODO: Move production WebSocket auth away from query tokens to a stronger session mechanism.
  backendUrl.search = new URLSearchParams({ token }).toString();
  return backendUrl.toString();
}

export function createDiscussion(
  token: string,
  sourceGroupId: string,
  sourceMessageId: string,
  title?: string | null
) {
  return apiFetch<OfficeChatDiscussion>("/api/discussions", token, {
    method: "POST",
    body: JSON.stringify({
      source_group_id: sourceGroupId,
      source_message_id: sourceMessageId,
      title: title ?? null
    })
  });
}

export function getDiscussionByMessage(token: string, messageId: string) {
  return apiFetch<OfficeChatDiscussion>(`/api/discussions/by-message/${messageId}`, token);
}

export function getDiscussion(token: string, discussionId: string) {
  return apiFetch<OfficeChatDiscussion>(`/api/discussions/${discussionId}`, token);
}

export function getDiscussionMessages(token: string, discussionId: string, limit = 50) {
  return apiFetch<OfficeChatDiscussionMessage[]>(`/api/discussions/${discussionId}/messages?limit=${limit}`, token);
}

export function getArchivedDiscussionMessages(token: string, discussionId: string, limit = 50, before?: string) {
  const query = new URLSearchParams({ limit: String(limit) });
  if (before) query.set("before", before);
  return apiFetch<OfficeChatDiscussionMessage[]>(
    `/api/discussions/${discussionId}/messages/archive?${query}`,
    token
  );
}

export function sendDiscussionMessage(token: string, discussionId: string, body: string) {
  return apiFetch<OfficeChatDiscussionMessage>(`/api/discussions/${discussionId}/messages`, token, {
    method: "POST",
    body: JSON.stringify({ body })
  });
}

export function sendDiscussionMessageWithAttachment(
  token: string,
  discussionId: string,
  body: string,
  file: File
) {
  return uploadMessageWithAttachment<OfficeChatDiscussionMessage>(
    `/api/discussions/${discussionId}/messages/with-attachment`,
    token,
    body,
    file
  );
}

export function sendDiscussionMessageWithAttachments(
  token: string,
  discussionId: string,
  body: string,
  files: File[]
) {
  return uploadMessageWithAttachments<OfficeChatDiscussionMessage>(
    `/api/discussions/${discussionId}/messages/with-attachments`, token, body, files
  );
}

export function editDiscussionMessage(token: string, discussionId: string, messageId: string, body: string) {
  return apiFetch<OfficeChatDiscussionMessage>(`/api/discussions/${discussionId}/messages/${messageId}`, token, {
    method: "PATCH",
    body: JSON.stringify({ body })
  });
}

export function deleteDiscussionMessage(token: string, discussionId: string, messageId: string) {
  return apiFetch<OfficeChatDiscussionMessage>(`/api/discussions/${discussionId}/messages/${messageId}`, token, {
    method: "DELETE"
  });
}

export function addDiscussionMessageReaction(token: string, discussionId: string, messageId: string, emoji: string) {
  return apiFetch<OfficeChatMessageReaction[]>(
    `/api/discussions/${discussionId}/messages/${messageId}/reactions`,
    token,
    { method: "PUT", body: JSON.stringify({ emoji }) }
  );
}

export function removeDiscussionMessageReaction(token: string, discussionId: string, messageId: string, emoji: string) {
  return apiFetch<OfficeChatMessageReaction[]>(
    `/api/discussions/${discussionId}/messages/${messageId}/reactions`,
    token,
    { method: "DELETE", body: JSON.stringify({ emoji }) }
  );
}

export function addDiscussionMember(
  token: string,
  discussionId: string,
  username: string,
  role: DiscussionMemberRole = "member"
) {
  return apiFetch<OfficeChatDiscussionMember>(`/api/discussions/${discussionId}/members`, token, {
    method: "POST",
    body: JSON.stringify({ username, role })
  });
}

export function removeDiscussionMember(token: string, discussionId: string, memberId: string) {
  return apiFetch<void>(`/api/discussions/${discussionId}/members/${memberId}`, token, {
    method: "DELETE"
  });
}

export function getDiscussionWebSocketUrl(token: string, discussionId: string) {
  const backendUrl = new URL(apiBaseUrl);
  backendUrl.protocol = backendUrl.protocol === "https:" ? "wss:" : "ws:";
  backendUrl.pathname = `/api/ws/discussions/${discussionId}`;
  // TODO: Move production WebSocket auth away from query tokens to a stronger session mechanism.
  backendUrl.search = new URLSearchParams({ token }).toString();
  return backendUrl.toString();
}

export function buildAttachmentDownloadUrl(downloadUrl: string) {
  return `${apiBaseUrl}${downloadUrl}`;
}

export async function downloadAttachment(token: string, downloadUrl: string) {
  const response = await authenticatedFetch(buildAttachmentDownloadUrl(downloadUrl), token, {
    headers: {
      Authorization: `Bearer ${token}`
    }
  });

  if (!response.ok) {
    throw new Error(response.statusText);
  }

  return response.blob();
}

export function downloadDirectAttachment(token: string, downloadUrl: string) {
  return downloadAttachment(token, downloadUrl);
}

export function downloadDiscussionAttachment(token: string, downloadUrl: string) {
  return downloadAttachment(token, downloadUrl);
}
