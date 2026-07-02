from datetime import datetime
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, ValidationInfo, field_validator, model_validator

from app.schemas.reaction import MessageReactionPublic, aggregate_reaction_rows
from app.schemas.user import UserDirectoryEntry

REPLY_PREVIEW_MAX_LENGTH = 120


class DirectConversationCreate(BaseModel):
    username: str = Field(min_length=1, max_length=64)


class DirectMessageCreate(BaseModel):
    body: str = Field(min_length=1)
    message_type: str = Field(default="text", max_length=32)
    reply_to_message_id: UUID | None = None


class DirectMessageUpdate(BaseModel):
    body: str = Field(min_length=1)


class DirectMessageAttachmentPublic(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: UUID
    original_filename: str
    content_type: str | None
    size_bytes: int
    created_at: datetime
    download_url: str


class DirectMessageReplySenderPublic(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: UUID
    username: str
    display_name: str


class DirectMessageReplyPreviewPublic(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: UUID
    sender: DirectMessageReplySenderPublic
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
        if len(preview) > REPLY_PREVIEW_MAX_LENGTH:
            preview = f"{preview[: REPLY_PREVIEW_MAX_LENGTH - 3]}..."

        return {
            "id": getattr(data, "id"),
            "sender": getattr(data, "sender"),
            "body_preview": preview,
            "is_deleted": getattr(data, "is_deleted"),
            "created_at": getattr(data, "created_at"),
        }


class DirectMessagePublic(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: UUID
    conversation_id: UUID
    sender_user_id: UUID
    reply_to_message_id: UUID | None
    body: str
    message_type: str
    is_deleted: bool
    edited_at: datetime | None
    created_at: datetime
    updated_at: datetime
    sender: UserDirectoryEntry
    reply_to: DirectMessageReplyPreviewPublic | None = None
    attachments: list[DirectMessageAttachmentPublic] = Field(default_factory=list)
    reactions: list[MessageReactionPublic] = Field(default_factory=list)

    @field_validator("reactions", mode="before")
    @classmethod
    def summarize_reactions(cls, value: object, info: ValidationInfo) -> object:
        current_user_id = info.context.get("current_user_id") if info.context else None
        return aggregate_reaction_rows(value, current_user_id)


class DirectConversationPublic(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: UUID
    user_one_id: UUID
    user_two_id: UUID
    created_at: datetime
    updated_at: datetime
    other_user: UserDirectoryEntry
    last_message: DirectMessagePublic | None = None
