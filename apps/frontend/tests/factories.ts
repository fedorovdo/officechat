import type {
  AuditEvent,
  OfficeChatDirectConversation,
  OfficeChatMessageSearchResult,
  OfficeChatUnreadSummary,
  OfficeChatUser
} from "../lib/api";

export function userFactory(overrides: Partial<OfficeChatUser> = {}): OfficeChatUser {
  return {
    id: "00000000-0000-4000-8000-000000000001",
    username: "dmitrii",
    display_name: "Дмитрий",
    email: "dmitrii@example.test",
    role: "user",
    is_active: true,
    is_system: false,
    auth_provider: "local",
    avatar_url: null,
    created_at: "2026-07-04T10:00:00Z",
    updated_at: "2026-07-04T10:00:00Z",
    last_login_at: "2026-07-04T10:00:00Z",
    last_seen_at: null,
    ...overrides
  };
}

export function unreadFactory(overrides: Partial<OfficeChatUnreadSummary> = {}): OfficeChatUnreadSummary {
  return {
    total: 5,
    groups: 2,
    direct: 3,
    discussions: 0,
    chats: [
      {
        chat_type: "group",
        chat_id: "group-1",
        unread_count: 2,
        mention_count: 1,
        first_unread_message_id: "message-1",
        newest_unread_message_id: "message-2"
      },
      {
        chat_type: "direct",
        chat_id: "direct-1",
        unread_count: 3,
        mention_count: 0,
        first_unread_message_id: "message-3",
        newest_unread_message_id: "message-5"
      }
    ],
    ...overrides
  };
}

export function searchResultFactory(
  overrides: Partial<OfficeChatMessageSearchResult> = {}
): OfficeChatMessageSearchResult {
  return {
    chat_type: "group",
    chat_id: "group-1",
    chat_title: "IT Department",
    source_group_id: null,
    message_id: "message-1",
    sender: {
      id: "00000000-0000-4000-8000-000000000001",
      username: "dmitrii",
      display_name: "Дмитрий",
      avatar_url: null
    },
    created_at: "2026-07-04T10:00:00Z",
    excerpt: "Critical server alert",
    attachment_count: 0,
    matched_attachment_names: [],
    is_edited: false,
    reply_to_message_id: null,
    ...overrides
  };
}

export function conversationFactory(
  overrides: Partial<OfficeChatDirectConversation> = {}
): OfficeChatDirectConversation {
  return {
    id: "direct-1",
    user_one_id: "00000000-0000-4000-8000-000000000001",
    user_two_id: "00000000-0000-4000-8000-000000000002",
    created_at: "2026-07-04T10:00:00Z",
    updated_at: "2026-07-04T10:00:00Z",
    other_user: userFactory({ id: "00000000-0000-4000-8000-000000000002", username: "vladimir", display_name: "Владимир" }),
    last_message: null,
    ...overrides
  };
}

export function auditEventFactory(overrides: Partial<AuditEvent> = {}): AuditEvent {
  return {
    id: "audit-1",
    event_type: "admin.user.updated",
    category: "admin",
    action: "update",
    status: "success",
    actor_user_id: "00000000-0000-4000-8000-000000000001",
    actor_username: "admin",
    actor_display_name: "OfficeChat Admin",
    actor_role: "admin",
    target_type: "user",
    target_id: "00000000-0000-4000-8000-000000000002",
    target_label: "Very long target label ".repeat(20),
    source_ip: "127.0.0.1",
    user_agent: "Test Agent ".repeat(30),
    request_id: "request-1",
    details: { payload: "long-value-".repeat(100) },
    error_code: null,
    error_message: null,
    created_at: "2026-07-04T10:00:00Z",
    ...overrides
  };
}
