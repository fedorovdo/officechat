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

const apiBaseUrl = process.env.NEXT_PUBLIC_BACKEND_URL;

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
