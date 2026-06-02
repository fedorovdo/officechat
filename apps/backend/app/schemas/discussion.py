from datetime import datetime
from typing import Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, model_validator

from app.schemas.user import UserDirectoryEntry

DiscussionMemberRole = Literal["owner", "member"]
DISCUSSION_SOURCE_PREVIEW_MAX_LENGTH = 160


class DiscussionCreate(BaseModel):
    source_group_id: UUID
    source_message_id: UUID
    title: str | None = Field(default=None, max_length=255)


class DiscussionMemberCreate(BaseModel):
    username: str = Field(min_length=1, max_length=64)
    role: DiscussionMemberRole = "member"


class DiscussionMemberPublic(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: UUID
    discussion_id: UUID
    user_id: UUID
    role: DiscussionMemberRole
    joined_at: datetime
    user: UserDirectoryEntry


class DiscussionSourceMessagePreviewPublic(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: UUID
    sender: UserDirectoryEntry
    body_preview: str
    is_deleted: bool
    created_at: datetime

    @model_validator(mode="before")
    @classmethod
    def build_preview(cls, data: object) -> object:
        if isinstance(data, dict):
            return data

        body = str(getattr(data, "body", "") or "").strip()
        preview = "Message deleted" if getattr(data, "is_deleted", False) else body
        if len(preview) > DISCUSSION_SOURCE_PREVIEW_MAX_LENGTH:
            preview = f"{preview[: DISCUSSION_SOURCE_PREVIEW_MAX_LENGTH - 3]}..."

        return {
            "id": getattr(data, "id"),
            "sender": getattr(data, "sender"),
            "body_preview": preview,
            "is_deleted": getattr(data, "is_deleted"),
            "created_at": getattr(data, "created_at"),
        }


class DiscussionPublic(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: UUID
    source_group_id: UUID
    source_message_id: UUID
    title: str | None
    created_by_user_id: UUID
    is_active: bool
    created_at: datetime
    updated_at: datetime
    source_message: DiscussionSourceMessagePreviewPublic
    members: list[DiscussionMemberPublic] = Field(default_factory=list)
    can_manage_members: bool = False


class DiscussionMessageCreate(BaseModel):
    body: str = Field(min_length=1)


class DiscussionMessageUpdate(BaseModel):
    body: str = Field(min_length=1)


class DiscussionMessagePublic(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: UUID
    discussion_id: UUID
    sender_user_id: UUID
    body: str
    is_deleted: bool
    edited_at: datetime | None
    created_at: datetime
    updated_at: datetime
    sender: UserDirectoryEntry
