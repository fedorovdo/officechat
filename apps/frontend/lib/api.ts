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
  body: string;
  message_type: string;
  is_deleted: boolean;
  edited_at: string | null;
  created_at: string;
  updated_at: string;
  sender: OfficeChatUser;
  attachments: OfficeChatMessageAttachment[];
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

export type GroupMessageEvent = {
  type: "message.created" | "message.updated" | "message.deleted";
  group_id: string;
  message: OfficeChatMessage;
  message_id?: string;
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

export function isAdminRole(role: string) {
  return role === "superadmin" || role === "admin";
}

export function getGroups(token: string) {
  return apiFetch<OfficeChatGroup[]>("/api/groups", token);
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

export function sendGroupMessage(token: string, groupId: string, body: string) {
  return apiFetch<OfficeChatMessage>(`/api/groups/${groupId}/messages`, token, {
    method: "POST",
    body: JSON.stringify({ body, message_type: "text" })
  });
}

export async function sendGroupMessageWithAttachment(
  token: string,
  groupId: string,
  body: string,
  file: File
) {
  const formData = new FormData();
  formData.append("file", file);
  if (body.trim()) {
    formData.append("body", body);
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
