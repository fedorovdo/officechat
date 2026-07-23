import {
  clearStoredAccessToken,
  expireAuthentication,
  getStoredAccessToken,
  requireStoredAccessToken,
  storeAccessToken
} from "./session";
import { buildWebSocketUrl, getApiBaseUrl } from "./public-url";

export type UserRole = "superadmin" | "admin" | "group_owner" | "moderator" | "user" | "bot";
export type GroupRole = "owner" | "moderator" | "member";
export type DiscussionMemberRole = "owner" | "member";
export type PermissionKey = "can_broadcast" | "can_pin_messages" | "can_manage_calendar";
export type BroadcastPriority = "normal" | "important" | "urgent";
export type BroadcastAudienceType = "all_active_users" | "selected_groups" | "selected_users";
export type BroadcastStatus = "draft" | "sending" | "sent" | "failed" | "partially_failed" | "retracted";
export type CalendarEventType = "meeting" | "video_conference" | "office_event" | "training" | "maintenance" | "other";
export type CalendarEventStatus = "scheduled" | "rescheduled" | "cancelled" | "completed";
export type CalendarAudienceType = "all_active_users" | "selected_groups" | "selected_users";

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
  permissions: PermissionKey[];
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

export type OfficeChatMessageSearchSender = {
  id: string;
  username: string;
  display_name: string;
  avatar_url: string | null;
};

export type OfficeChatMessageSearchResult = {
  chat_type: ChatType;
  chat_id: string;
  chat_title: string;
  source_group_id: string | null;
  message_id: string;
  sender: OfficeChatMessageSearchSender;
  created_at: string;
  excerpt: string;
  attachment_count: number;
  matched_attachment_names: string[];
  is_edited: boolean;
  reply_to_message_id: string | null;
};

export type OfficeChatMessageSearchPage = {
  items: OfficeChatMessageSearchResult[];
  next_cursor: string | null;
  total_estimate: number | null;
};

export type OfficeChatMessageContext = {
  chat_type: ChatType;
  chat_id: string;
  target_message_id: string;
  messages: Array<OfficeChatMessage | OfficeChatDirectMessage | OfficeChatDiscussionMessage>;
  has_more_before: boolean;
  has_more_after: boolean;
};

export type MessageSearchFilters = {
  q: string;
  chat_type?: ChatType;
  chat_id?: string;
  sender_id?: string;
  date_from?: string;
  date_to?: string;
  has_attachment?: boolean;
  limit?: number;
  cursor?: string;
};

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
  notification_unread_count: number;
  read_notification_ids: string[];
};

export type LegacyUnreadRepairResult = {
  cleared_messages: number;
  cleared_chats: number;
  unread: OfficeChatUnreadSummary;
  notification_unread_count: number;
  read_notifications: number;
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
  is_pinned: boolean;
  pin_id: string | null;
  pinned_at: string | null;
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
  is_pinned: boolean;
  pin_id: string | null;
  pinned_at: string | null;
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
  is_pinned: boolean;
  pin_id: string | null;
  pinned_at: string | null;
  edited_at: string | null;
  created_at: string;
  updated_at: string;
  sender: OfficeChatDirectoryUser;
  attachments: OfficeChatAttachment[];
  reactions: OfficeChatMessageReaction[];
};

export type OfficeChatPinnedMessage = {
  id: string;
  chat_type: ChatType;
  chat_id: string;
  message_id: string;
  note: string | null;
  pinned_by: {
    id: string | null;
    username: string;
    display_name: string;
  };
  pinned_at: string;
  created_at: string;
  updated_at: string;
  message: {
    id: string;
    sender: {
      id: string;
      username: string;
      display_name: string;
    };
    body_preview: string;
    attachment_count: number;
    is_deleted: boolean;
    is_archived: boolean;
    archived_at: string | null;
    created_at: string;
  };
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
      type: "message.pinned" | "message.pin_updated";
      chat_type: ChatType;
      chat_id: string;
      group_id?: string;
      pin_id: string;
      message_id: string;
      pin: OfficeChatPinnedMessage;
    }
  | {
      type: "message.unpinned";
      chat_type: ChatType;
      chat_id: string;
      group_id?: string;
      pin_id: string;
      message_id: string;
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
      type: "message.pinned" | "message.pin_updated";
      chat_type: ChatType;
      chat_id: string;
      pin_id: string;
      message_id: string;
      pin: OfficeChatPinnedMessage;
    }
  | {
      type: "message.unpinned";
      chat_type: ChatType;
      chat_id: string;
      pin_id: string;
      message_id: string;
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
      type: "message.pinned" | "message.pin_updated";
      chat_type: ChatType;
      chat_id: string;
      pin_id: string;
      message_id: string;
      pin: OfficeChatPinnedMessage;
    }
  | {
      type: "message.unpinned";
      chat_type: ChatType;
      chat_id: string;
      pin_id: string;
      message_id: string;
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
      type: "permissions.updated";
      permissions: PermissionKey[];
    }
  | {
      type: "announcement.created";
      announcement: OfficeChatAnnouncementEvent;
      unread_count: number;
    }
  | {
      type: "announcement.read" | "announcement.retracted";
      announcement_id: string;
      unread_count: number;
    }
  | {
      type: "calendar.event_created" | "calendar.event_updated";
      event: OfficeChatCalendarEvent;
    }
  | {
      type: "calendar.event_cancelled";
      event: OfficeChatCalendarEvent;
    }
  | {
      type: "calendar.reminder";
      event: OfficeChatCalendarEvent;
      reminder_minutes: number;
    }
  | {
      type: "presence.updated";
      user_id: string;
      status: "online" | "offline";
      last_seen_at: string | null;
    }
  | {
      type: "notification.created";
      notification: OfficeChatNotification;
      unread_count: number;
    }
  | {
      type: "notification.read" | "notification.dismissed";
      notification_id: string;
      unread_count: number;
    }
  | {
      type: "notifications.read_all";
      category: string | null;
      unread_count: number;
    }
  | {
      type: "notifications.messages_read";
      notification_ids: string[];
      unread_count: number;
      refresh?: boolean;
    }
  | {
      type: "notification.preferences_updated";
      preferences: NotificationPreferences;
    }
  | UnreadEvent
  | { type: "unread.refresh" };

export type BroadcastAudiencePayload = {
  audience_type: BroadcastAudienceType;
  group_ids?: string[];
  user_ids?: string[];
};

export type BroadcastCreatePayload = BroadcastAudiencePayload & {
  title: string;
  body: string;
  priority: BroadcastPriority;
  expires_at?: string | null;
};

export type BroadcastUpdatePayload = Partial<BroadcastCreatePayload>;

export type BroadcastPreview = {
  recipient_count: number;
  group_count: number;
  excluded_disabled: number;
  excluded_bots: number;
  duplicates_removed: number;
  audience_hash: string;
  confirmation_token: string;
  expires_at: string;
};

export type BroadcastAnnouncement = {
  id: string;
  created_by_user_id: string | null;
  created_by_username: string;
  created_by_display_name: string;
  title: string;
  body: string;
  priority: BroadcastPriority;
  status: BroadcastStatus;
  audience_type: BroadcastAudienceType;
  audience_definition: Record<string, unknown> | null;
  recipient_count: number;
  notified_count: number;
  read_count: number;
  failed_count: number;
  sent_at: string | null;
  expires_at: string | null;
  retracted_at: string | null;
  created_at: string;
  updated_at: string;
};

export type BroadcastPage = {
  items: BroadcastAnnouncement[];
  total: number;
  page: number;
  limit: number;
};

export type BroadcastStats = {
  recipients: number;
  notified: number;
  offline: number;
  read: number;
  unread: number;
  failed: number;
  read_percentage: number;
};

export type OfficeChatAnnouncement = {
  id: string;
  title: string;
  body: string | null;
  priority: BroadcastPriority;
  status: BroadcastStatus;
  sender: string;
  sent_at: string | null;
  expires_at: string | null;
  is_read: boolean;
  read_at: string | null;
  dismissed_at: string | null;
  preview: string;
};

export type OfficeChatAnnouncementEvent = {
  id: string;
  title: string;
  priority: BroadcastPriority;
  sent_at: string | null;
  sender_user_id: string | null;
  sender_display_name: string;
  is_read: boolean;
};

export type CalendarAudiencePayload = {
  audience_type: CalendarAudienceType;
  group_ids?: string[];
  user_ids?: string[];
};

export type CalendarEventPayload = CalendarAudiencePayload & {
  title: string;
  description?: string | null;
  event_type: CalendarEventType;
  is_all_day: boolean;
  starts_at?: string | null;
  ends_at?: string | null;
  all_day_start_date?: string | null;
  all_day_end_date?: string | null;
  timezone?: string | null;
  location?: string | null;
  conference_url?: string | null;
  reminder_minutes?: number[];
};

export type CalendarEventUpdatePayload = Partial<CalendarEventPayload>;

export type OfficeChatCalendarEvent = {
  id: string;
  title: string;
  description: string | null;
  event_type: CalendarEventType;
  status: CalendarEventStatus;
  is_all_day: boolean;
  starts_at: string | null;
  ends_at: string | null;
  all_day_start_date: string | null;
  all_day_end_date: string | null;
  timezone: string;
  location: string | null;
  conference_url: string | null;
  created_by: {
    id: string | null;
    username: string | null;
    display_name: string | null;
  };
  audience_summary: {
    type: CalendarAudienceType;
    recipient_count: number;
  };
  editable_audience: CalendarAudiencePayload | null;
  reminder_minutes: number[];
  can_manage: boolean;
  cancelled_at: string | null;
  cancellation_reason: string | null;
  created_at: string;
  updated_at: string;
};

export type CalendarEventPage = {
  items: OfficeChatCalendarEvent[];
  total: number;
  limit: number;
};

export type CalendarAudiencePreview = {
  recipient_count: number;
  group_count: number;
  excluded_disabled: number;
  excluded_bots: number;
  duplicates_removed: number;
};

export type NotificationCategory = "messages" | "announcements" | "pins" | "calendar" | "system";
export type NotificationKind =
  | "mention"
  | "reply"
  | "reaction"
  | "direct_message"
  | "group_message"
  | "discussion_message"
  | "announcement"
  | "pin"
  | "calendar_created"
  | "calendar_updated"
  | "calendar_rescheduled"
  | "calendar_cancelled"
  | "calendar_reminder"
  | "system";

export type OfficeChatNotification = {
  id: string;
  type: NotificationKind | string;
  category: NotificationCategory | string;
  source_type: string | null;
  source_id: string | null;
  chat_type: ChatType | string | null;
  chat_id: string | null;
  message_id: string | null;
  actor: {
    id: string | null;
    username: string | null;
    display_name: string | null;
    avatar_url: string | null;
  };
  title_key: string;
  body_preview: string | null;
  metadata: Record<string, unknown> | null;
  is_read: boolean;
  read_at: string | null;
  is_dismissed: boolean;
  dismissed_at: string | null;
  created_at: string;
  updated_at: string;
};

export type NotificationPage = {
  items: OfficeChatNotification[];
  next_cursor: string | null;
};

export type NotificationPreferences = {
  mentions_enabled: boolean;
  replies_enabled: boolean;
  reactions_enabled: boolean;
  direct_messages_enabled: boolean;
  group_messages_enabled: boolean;
  discussion_messages_enabled: boolean;
  announcements_enabled: boolean;
  pins_enabled: boolean;
  calendar_events_enabled: boolean;
  calendar_reminders_enabled: boolean;
  calendar_changes_enabled: boolean;
  system_enabled: boolean;
  desktop_notifications_enabled: boolean;
  sound_enabled: boolean;
  quiet_hours_enabled: boolean;
  quiet_hours_start: string | null;
  quiet_hours_end: string | null;
  timezone: string | null;
  created_at: string;
  updated_at: string;
};

export type NotificationPreferencesUpdate = Partial<
  Pick<
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
  >
>;

export type AnnouncementPage = {
  items: OfficeChatAnnouncement[];
  total: number;
  page: number;
  limit: number;
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

export type OfficeChatPermission = {
  key: PermissionKey;
  category: string;
  description_ru: string;
  description_en: string;
  is_active: boolean;
  created_at: string;
  updated_at: string;
};

export type OfficeChatUserPermissionState = {
  explicit_permissions: PermissionKey[];
  effective_permissions: PermissionKey[];
  inherited_from_superadmin: boolean;
};

const apiBaseUrl = getApiBaseUrl();

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

export function getAdminPermissions(token: string) {
  return apiFetch<OfficeChatPermission[]>("/api/admin/permissions", token);
}

export function getAdminUserPermissions(token: string, userId: string) {
  return apiFetch<OfficeChatUserPermissionState>(`/api/admin/users/${userId}/permissions`, token);
}

export function updateAdminUserPermissions(token: string, userId: string, permissions: PermissionKey[]) {
  return apiFetch<OfficeChatUserPermissionState>(`/api/admin/users/${userId}/permissions`, token, {
    method: "PUT",
    body: JSON.stringify({ permissions })
  });
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

export function getAnnouncements(token: string, page = 1, limit = 20) {
  return apiFetch<AnnouncementPage>(`/api/announcements?page=${page}&limit=${limit}`, token);
}

export function getAnnouncement(token: string, announcementId: string) {
  return apiFetch<OfficeChatAnnouncement>(`/api/announcements/${announcementId}`, token);
}

export function markAnnouncementRead(token: string, announcementId: string) {
  return apiFetch<OfficeChatAnnouncement>(`/api/announcements/${announcementId}/read`, token, { method: "POST" });
}

export function dismissAnnouncement(token: string, announcementId: string) {
  return apiFetch<OfficeChatAnnouncement>(`/api/announcements/${announcementId}/dismiss`, token, { method: "POST" });
}

export function getAnnouncementUnread(token: string) {
  return apiFetch<{ unread_count: number }>("/api/announcements/unread", token);
}

export function getNotifications(
  token: string,
  params: {
    limit?: number;
    cursor?: string | null;
    category?: string | null;
    type?: string | null;
    unreadOnly?: boolean;
    includeDismissed?: boolean;
  } = {}
) {
  const query = new URLSearchParams({ limit: String(params.limit ?? 30) });
  if (params.cursor) query.set("cursor", params.cursor);
  if (params.category) query.set("category", params.category);
  if (params.type) query.set("type", params.type);
  if (params.unreadOnly) query.set("unread_only", "true");
  if (params.includeDismissed) query.set("include_dismissed", "true");
  return apiFetch<NotificationPage>(`/api/notifications?${query}`, token);
}

export function getNotificationUnreadCount(token: string) {
  return apiFetch<{ unread_count: number }>("/api/notifications/unread-count", token);
}

export function markNotificationRead(token: string, notificationId: string) {
  return apiFetch<OfficeChatNotification>(`/api/notifications/${notificationId}/read`, token, { method: "POST" });
}

export function markAllNotificationsRead(token: string, category?: string | null) {
  return apiFetch<{ marked_read: number; unread_count: number }>("/api/notifications/read-all", token, {
    method: "POST",
    body: JSON.stringify({ category: category ?? null })
  });
}

export function dismissNotification(token: string, notificationId: string) {
  return apiFetch<OfficeChatNotification>(`/api/notifications/${notificationId}/dismiss`, token, { method: "POST" });
}

export function getNotificationPreferences(token: string) {
  return apiFetch<NotificationPreferences>("/api/notifications/preferences", token);
}

export function updateNotificationPreferences(token: string, payload: NotificationPreferencesUpdate) {
  return apiFetch<NotificationPreferences>("/api/notifications/preferences", token, {
    method: "PUT",
    body: JSON.stringify(payload)
  });
}

export function createBroadcast(token: string, payload: BroadcastCreatePayload) {
  return apiFetch<BroadcastAnnouncement>("/api/broadcasts", token, {
    method: "POST",
    body: JSON.stringify(payload)
  });
}

export function updateBroadcast(token: string, broadcastId: string, payload: BroadcastUpdatePayload) {
  return apiFetch<BroadcastAnnouncement>(`/api/broadcasts/${broadcastId}`, token, {
    method: "PATCH",
    body: JSON.stringify(payload)
  });
}

export function previewBroadcastRecipients(token: string, payload: BroadcastAudiencePayload) {
  return apiFetch<BroadcastPreview>("/api/broadcasts/preview", token, {
    method: "POST",
    body: JSON.stringify(payload)
  });
}

export function sendBroadcast(
  token: string,
  broadcastId: string,
  payload: { confirmation_token: string; expected_recipient_count: number; idempotency_key?: string | null }
) {
  return apiFetch<BroadcastAnnouncement>(`/api/broadcasts/${broadcastId}/send`, token, {
    method: "POST",
    body: JSON.stringify(payload)
  });
}

export function retractBroadcast(token: string, broadcastId: string) {
  return apiFetch<BroadcastAnnouncement>(`/api/broadcasts/${broadcastId}/retract`, token, { method: "POST" });
}

export function getSentBroadcasts(token: string, page = 1, limit = 20) {
  return apiFetch<BroadcastPage>(`/api/broadcasts/sent?page=${page}&limit=${limit}`, token);
}

export function getBroadcastStats(token: string, broadcastId: string) {
  return apiFetch<BroadcastStats>(`/api/broadcasts/${broadcastId}/stats`, token);
}

export type CalendarEventQuery = {
  date_from: string;
  date_to: string;
  status?: CalendarEventStatus | "";
  event_type?: CalendarEventType | "";
  include_cancelled?: boolean;
  limit?: number;
};

function buildCalendarEventQuery(query: CalendarEventQuery) {
  const params = new URLSearchParams({
    date_from: query.date_from,
    date_to: query.date_to,
    include_cancelled: String(query.include_cancelled ?? true),
    limit: String(query.limit ?? 200)
  });
  if (query.status) params.set("status", query.status);
  if (query.event_type) params.set("event_type", query.event_type);
  return params.toString();
}

export function getCalendarEvents(token: string, query: CalendarEventQuery) {
  return apiFetch<CalendarEventPage>(`/api/calendar/events?${buildCalendarEventQuery(query)}`, token);
}

export function getCalendarEvent(token: string, eventId: string) {
  return apiFetch<OfficeChatCalendarEvent>(`/api/calendar/events/${eventId}`, token);
}

export function previewCalendarAudience(token: string, payload: CalendarAudiencePayload) {
  return apiFetch<CalendarAudiencePreview>("/api/calendar/events/preview-audience", token, {
    method: "POST",
    body: JSON.stringify(payload)
  });
}

export function createCalendarEvent(token: string, payload: CalendarEventPayload) {
  return apiFetch<OfficeChatCalendarEvent>("/api/calendar/events", token, {
    method: "POST",
    body: JSON.stringify(payload)
  });
}

export function updateCalendarEvent(token: string, eventId: string, payload: CalendarEventUpdatePayload) {
  return apiFetch<OfficeChatCalendarEvent>(`/api/calendar/events/${eventId}`, token, {
    method: "PATCH",
    body: JSON.stringify(payload)
  });
}

export function cancelCalendarEvent(token: string, eventId: string, reason?: string | null) {
  return apiFetch<OfficeChatCalendarEvent>(`/api/calendar/events/${eventId}/cancel`, token, {
    method: "POST",
    body: JSON.stringify({ reason: reason ?? null })
  });
}

export function restoreCalendarEvent(token: string, eventId: string) {
  return apiFetch<OfficeChatCalendarEvent>(`/api/calendar/events/${eventId}/restore`, token, { method: "POST" });
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

export function markAllCurrentRead(token: string) {
  return apiFetch<LegacyUnreadRepairResult>(
    "/api/read-state/mark-all-current-read",
    token,
    { method: "POST" }
  );
}

export function getDirectReadReceipt(token: string, conversationId: string) {
  return apiFetch<OfficeChatDirectReadReceipt>(`/api/read-state/direct/${conversationId}/receipt`, token);
}

export function searchMessages(token: string, filters: MessageSearchFilters, signal?: AbortSignal) {
  const query = new URLSearchParams({ q: filters.q, limit: String(filters.limit ?? 30) });
  if (filters.chat_type) query.set("chat_type", filters.chat_type);
  if (filters.chat_id) query.set("chat_id", filters.chat_id);
  if (filters.sender_id) query.set("sender_id", filters.sender_id);
  if (filters.date_from) query.set("date_from", filters.date_from);
  if (filters.date_to) query.set("date_to", filters.date_to);
  if (filters.has_attachment) query.set("has_attachment", "true");
  if (filters.cursor) query.set("cursor", filters.cursor);
  return apiFetch<OfficeChatMessageSearchPage>(`/api/search/messages?${query}`, token, { signal });
}

export function getMessageContext(
  token: string,
  chatType: ChatType,
  chatId: string,
  messageId: string,
  before = 20,
  after = 20,
  signal?: AbortSignal
) {
  const query = new URLSearchParams({
    chat_type: chatType,
    chat_id: chatId,
    message_id: messageId,
    before: String(before),
    after: String(after)
  });
  return apiFetch<OfficeChatMessageContext>(`/api/search/context?${query}`, token, { signal });
}

export function getPresence(token: string, userIds: string[]) {
  return apiFetch<OfficeChatPresence[]>("/api/presence/query", token, {
    method: "POST",
    body: JSON.stringify({ user_ids: Array.from(new Set(userIds)).slice(0, 100) })
  });
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

export function hasPermission(user: Pick<OfficeChatUser, "permissions"> | null | undefined, permission: PermissionKey) {
  return Boolean(user?.permissions.includes(permission));
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

export function getPinnedMessages(token: string, chatType: ChatType, chatId: string) {
  const query = new URLSearchParams({ chat_type: chatType, chat_id: chatId });
  return apiFetch<OfficeChatPinnedMessage[]>(`/api/pins?${query}`, token);
}

export function pinMessage(token: string, chatType: ChatType, chatId: string, messageId: string, note?: string | null) {
  return apiFetch<OfficeChatPinnedMessage>("/api/pins", token, {
    method: "POST",
    body: JSON.stringify({ chat_type: chatType, chat_id: chatId, message_id: messageId, note: note || null })
  });
}

export function updatePinnedMessage(token: string, pinId: string, note?: string | null) {
  return apiFetch<OfficeChatPinnedMessage>(`/api/pins/${pinId}`, token, {
    method: "PATCH",
    body: JSON.stringify({ note: note || null })
  });
}

export function unpinMessage(token: string, pinId: string) {
  return apiFetch<void>(`/api/pins/${pinId}`, token, { method: "DELETE" });
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
  // TODO: Move production WebSocket auth away from query tokens to a stronger session mechanism.
  return buildWebSocketUrl(`/api/ws/groups/${groupId}`, token);
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
  // TODO: Move production WebSocket auth away from query tokens to a stronger session mechanism.
  return buildWebSocketUrl(`/api/ws/direct/${conversationId}`, token);
}

export function getPersonalWebSocketUrl(token: string) {
  // TODO: Move production WebSocket auth away from query tokens to a stronger session mechanism.
  return buildWebSocketUrl("/api/ws/me", token);
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
  // TODO: Move production WebSocket auth away from query tokens to a stronger session mechanism.
  return buildWebSocketUrl(`/api/ws/discussions/${discussionId}`, token);
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
