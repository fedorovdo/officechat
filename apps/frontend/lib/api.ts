export type UserRole = "superadmin" | "admin" | "group_owner" | "moderator" | "user" | "bot";
export type GroupRole = "owner" | "moderator" | "member";

export type OfficeChatUser = {
  id: string;
  username: string;
  display_name: string;
  email: string | null;
  role: UserRole;
  is_active: boolean;
  is_system: boolean;
  auth_provider: string;
  created_at: string;
  updated_at: string;
  last_login_at: string | null;
};

export type OfficeChatDirectoryUser = {
  id: string;
  username: string;
  display_name: string;
  role: UserRole;
  is_active: boolean;
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

export type OfficeChatMessage = {
  id: string;
  group_id: string;
  sender_user_id: string;
  reply_to_message_id: string | null;
  body: string;
  message_type: string;
  is_deleted: boolean;
  edited_at: string | null;
  created_at: string;
  updated_at: string;
  sender: OfficeChatUser;
  reply_to: OfficeChatMessageReplyPreview | null;
  attachments: OfficeChatMessageAttachment[];
};

export type OfficeChatMessageReplyPreview = {
  id: string;
  sender: Pick<OfficeChatUser, "id" | "username" | "display_name">;
  body_preview: string;
  is_deleted: boolean;
  created_at: string;
};

export type OfficeChatMessageAttachment = {
  id: string;
  group_id: string;
  original_filename: string;
  content_type: string | null;
  size_bytes: number;
  created_at: string;
  download_url: string;
};

export type OfficeChatDirectMessage = {
  id: string;
  conversation_id: string;
  sender_user_id: string;
  reply_to_message_id: string | null;
  body: string;
  message_type: string;
  is_deleted: boolean;
  edited_at: string | null;
  created_at: string;
  updated_at: string;
  sender: OfficeChatDirectoryUser;
  reply_to: OfficeChatDirectMessageReplyPreview | null;
};

export type OfficeChatDirectMessageReplyPreview = {
  id: string;
  sender: Pick<OfficeChatDirectoryUser, "id" | "username" | "display_name">;
  body_preview: string;
  is_deleted: boolean;
  created_at: string;
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

export type GroupMessageEvent = {
  type: "message.created" | "message.updated" | "message.deleted";
  group_id: string;
  message: OfficeChatMessage;
  message_id?: string;
};

export type DirectMessageEvent = {
  type: "direct.message.created" | "direct.message.updated" | "direct.message.deleted";
  conversation_id: string;
  message: OfficeChatDirectMessage;
  message_id?: string;
};

export type PersonalNotificationEvent =
  | {
      type: "user.group.message.created";
      group_id: string;
      group: Pick<OfficeChatGroup, "id" | "name" | "slug">;
      message: OfficeChatMessage;
    }
  | {
      type: "user.direct.message.created";
      conversation_id: string;
      other_user: OfficeChatDirectoryUser;
      message: OfficeChatDirectMessage;
    };

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

const apiBaseUrl = process.env.NEXT_PUBLIC_BACKEND_URL ?? "http://localhost:8100";

// TODO: Move production auth storage to secure cookies or a stronger session mechanism.
export function getStoredAccessToken() {
  return localStorage.getItem("officechat.access_token");
}

export function clearStoredAccessToken() {
  localStorage.removeItem("officechat.access_token");
}

async function apiFetch<T>(path: string, token: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`${apiBaseUrl}${path}`, {
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
    throw new Error(message);
  }

  if (response.status === 204) {
    return undefined as T;
  }

  return (await response.json()) as T;
}

export function getCurrentUser(token: string) {
  return apiFetch<OfficeChatUser>("/api/auth/me", token);
}

export function getAdminUsers(token: string) {
  return apiFetch<OfficeChatUser[]>("/api/admin/users", token);
}

export function getUsers(token: string) {
  return apiFetch<OfficeChatDirectoryUser[]>("/api/users", token);
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
  const formData = new FormData();
  formData.append("file", file);
  if (body.trim()) {
    formData.append("body", body);
  }
  if (replyToMessageId) {
    formData.append("reply_to_message_id", replyToMessageId);
  }

  const response = await fetch(`${apiBaseUrl}/api/groups/${groupId}/messages/with-attachment`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`
    },
    body: formData
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
    throw new Error(message);
  }

  return (await response.json()) as OfficeChatMessage;
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

export function buildAttachmentDownloadUrl(downloadUrl: string) {
  return `${apiBaseUrl}${downloadUrl}`;
}

export async function downloadAttachment(token: string, downloadUrl: string) {
  const response = await fetch(buildAttachmentDownloadUrl(downloadUrl), {
    headers: {
      Authorization: `Bearer ${token}`
    }
  });

  if (!response.ok) {
    throw new Error(response.statusText);
  }

  return response.blob();
}
