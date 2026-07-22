from datetime import datetime
from typing import Literal
from uuid import UUID

from pydantic import BaseModel, Field

ChatType = Literal["group", "direct", "discussion"]


class UnreadChatPublic(BaseModel):
    chat_type: ChatType
    chat_id: UUID
    unread_count: int
    mention_count: int = 0
    first_unread_message_id: UUID | None = None
    newest_unread_message_id: UUID | None = None


class UnreadSummaryPublic(BaseModel):
    total: int
    groups: int
    direct: int
    discussions: int
    chats: list[UnreadChatPublic]


class MarkReadRequest(BaseModel):
    chat_type: ChatType
    chat_id: UUID
    message_id: UUID


class ReadStatePublic(BaseModel):
    chat_type: ChatType
    chat_id: UUID
    last_read_message_id: UUID | None
    last_read_message_created_at: datetime | None
    last_read_at: datetime | None
    unread_count: int
    mention_count: int
    total_unread: int
    notification_unread_count: int
    read_notification_ids: list[UUID] = Field(default_factory=list)


class DirectReadReceiptPublic(BaseModel):
    conversation_id: UUID
    reader_user_id: UUID
    last_read_message_id: UUID | None
    last_read_message_created_at: datetime | None
    read_at: datetime | None
