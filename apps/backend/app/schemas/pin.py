from datetime import datetime
from typing import Literal
from uuid import UUID

from pydantic import BaseModel, Field, field_validator

ChatType = Literal["group", "direct", "discussion"]
PIN_PREVIEW_MAX_LENGTH = 120


class PinCreate(BaseModel):
    chat_type: ChatType
    chat_id: UUID
    message_id: UUID
    note: str | None = Field(default=None, max_length=300)

    @field_validator("note")
    @classmethod
    def normalize_note(cls, value: str | None) -> str | None:
        if value is None:
            return None
        normalized = value.replace("<", "").replace(">", "").strip()
        return normalized or None


class PinUpdate(BaseModel):
    note: str | None = Field(default=None, max_length=300)

    @field_validator("note")
    @classmethod
    def normalize_note(cls, value: str | None) -> str | None:
        if value is None:
            return None
        normalized = value.replace("<", "").replace(">", "").strip()
        return normalized or None


class PinUserPublic(BaseModel):
    id: UUID | None
    username: str
    display_name: str


class PinMessageSenderPublic(BaseModel):
    id: UUID
    username: str
    display_name: str


class PinMessagePreviewPublic(BaseModel):
    id: UUID
    sender: PinMessageSenderPublic
    body_preview: str
    attachment_count: int = 0
    is_deleted: bool
    is_archived: bool
    archived_at: datetime | None
    created_at: datetime


class PinnedMessagePublic(BaseModel):
    id: UUID
    chat_type: ChatType
    chat_id: UUID
    message_id: UUID
    note: str | None
    pinned_by: PinUserPublic
    pinned_at: datetime
    created_at: datetime
    updated_at: datetime
    message: PinMessagePreviewPublic
