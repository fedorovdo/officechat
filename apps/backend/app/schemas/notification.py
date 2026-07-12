from datetime import datetime
from typing import Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, model_validator

NotificationType = Literal[
    "mention",
    "reply",
    "reaction",
    "direct_message",
    "group_message",
    "discussion_message",
    "announcement",
    "pin",
    "system",
]
NotificationCategory = Literal["messages", "announcements", "pins", "system"]


class NotificationActorPublic(BaseModel):
    id: UUID | None
    username: str | None
    display_name: str | None
    avatar_url: str | None = None


class NotificationPublic(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: UUID
    type: str
    category: str
    source_type: str | None
    source_id: str | None
    chat_type: str | None
    chat_id: UUID | None
    message_id: UUID | None
    actor: NotificationActorPublic
    title_key: str
    body_preview: str | None
    metadata: dict[str, object] | None = None
    is_read: bool
    read_at: datetime | None
    is_dismissed: bool
    dismissed_at: datetime | None
    created_at: datetime
    updated_at: datetime

    @model_validator(mode="before")
    @classmethod
    def normalize_model(cls, data: object) -> object:
        if isinstance(data, dict):
            return data
        actor = getattr(data, "actor", None)
        return {
            "id": getattr(data, "id"),
            "type": getattr(data, "type"),
            "category": getattr(data, "category"),
            "source_type": getattr(data, "source_type"),
            "source_id": getattr(data, "source_id"),
            "chat_type": getattr(data, "chat_type"),
            "chat_id": getattr(data, "chat_id"),
            "message_id": getattr(data, "message_id"),
            "actor": {
                "id": getattr(data, "actor_user_id"),
                "username": getattr(actor, "username", None) or getattr(data, "actor_username"),
                "display_name": getattr(actor, "display_name", None) or getattr(data, "actor_display_name"),
                "avatar_url": getattr(actor, "avatar_url", None),
            },
            "title_key": getattr(data, "title_key"),
            "body_preview": getattr(data, "body_preview"),
            "metadata": getattr(data, "meta", None),
            "is_read": getattr(data, "is_read"),
            "read_at": getattr(data, "read_at"),
            "is_dismissed": getattr(data, "is_dismissed"),
            "dismissed_at": getattr(data, "dismissed_at"),
            "created_at": getattr(data, "created_at"),
            "updated_at": getattr(data, "updated_at"),
        }


class NotificationPage(BaseModel):
    items: list[NotificationPublic]
    next_cursor: str | None = None


class NotificationUnreadCount(BaseModel):
    unread_count: int


class NotificationReadAllRequest(BaseModel):
    category: str | None = Field(default=None, max_length=64)


class NotificationPreferencesPublic(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    mentions_enabled: bool
    replies_enabled: bool
    reactions_enabled: bool
    direct_messages_enabled: bool
    group_messages_enabled: bool
    discussion_messages_enabled: bool
    announcements_enabled: bool
    pins_enabled: bool
    system_enabled: bool
    desktop_notifications_enabled: bool
    sound_enabled: bool
    quiet_hours_enabled: bool
    quiet_hours_start: str | None
    quiet_hours_end: str | None
    timezone: str | None
    created_at: datetime
    updated_at: datetime


class NotificationPreferencesUpdate(BaseModel):
    mentions_enabled: bool | None = None
    replies_enabled: bool | None = None
    reactions_enabled: bool | None = None
    direct_messages_enabled: bool | None = None
    group_messages_enabled: bool | None = None
    discussion_messages_enabled: bool | None = None
    announcements_enabled: bool | None = None
    pins_enabled: bool | None = None
    system_enabled: bool | None = None
    desktop_notifications_enabled: bool | None = None
    sound_enabled: bool | None = None
