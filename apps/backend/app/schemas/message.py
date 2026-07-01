from datetime import datetime
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, ValidationInfo, computed_field, field_validator, model_validator

from app.schemas.reaction import MessageReactionPublic, aggregate_reaction_rows
from app.schemas.user import UserPublic

REPLY_PREVIEW_MAX_LENGTH = 120


class MessageCreate(BaseModel):
    body: str = Field(min_length=1)
    message_type: str = Field(default="text", max_length=32)
    reply_to_message_id: UUID | None = None


class MessageUpdate(BaseModel):
    body: str = Field(min_length=1)


class MessageAttachmentPublic(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: UUID
    group_id: UUID
    original_filename: str
    content_type: str | None
    size_bytes: int
    created_at: datetime

    @computed_field
    @property
    def download_url(self) -> str:
        return f"/api/groups/{self.group_id}/attachments/{self.id}/download"


class MessageReplySenderPublic(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: UUID
    username: str
    display_name: str


class MessageReplyPreviewPublic(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: UUID
    sender: MessageReplySenderPublic
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


class MessageMentionPublic(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    user_id: UUID
    username: str
    display_name: str

    @model_validator(mode="before")
    @classmethod
    def flatten_mentioned_user(cls, data: object) -> object:
        if isinstance(data, dict):
            return data

        user = getattr(data, "mentioned_user")
        return {
            "user_id": getattr(data, "mentioned_user_id"),
            "username": getattr(user, "username"),
            "display_name": getattr(user, "display_name"),
        }


class MessagePublic(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: UUID
    group_id: UUID
    sender_user_id: UUID
    reply_to_message_id: UUID | None
    body: str
    message_type: str
    is_deleted: bool
    edited_at: datetime | None
    created_at: datetime
    updated_at: datetime
    sender: UserPublic
    reply_to: MessageReplyPreviewPublic | None = None
    attachments: list[MessageAttachmentPublic] = Field(default_factory=list)
    mentions: list[MessageMentionPublic] = Field(default_factory=list)
    reactions: list[MessageReactionPublic] = Field(default_factory=list)

    @field_validator("reactions", mode="before")
    @classmethod
    def summarize_reactions(cls, value: object, info: ValidationInfo) -> object:
        current_user_id = info.context.get("current_user_id") if info.context else None
        return aggregate_reaction_rows(value, current_user_id)
