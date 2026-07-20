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
    file_available: bool
    file_deleted_at: datetime | None

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
    is_archived: bool
    archived_at: datetime | None
    created_at: datetime
    attachment_count: int = 0

    @model_validator(mode="before")
    @classmethod
    def build_preview(cls, data: object) -> object:
        if isinstance(data, dict):
            preview = dict(data)
            preview.setdefault("is_archived", False)
            preview.setdefault("archived_at", None)
            return preview

        body = str(getattr(data, "body", "") or "").strip()
        attachments = [] if getattr(data, "is_deleted", False) else getattr(data, "attachments", [])
        preview = "Message deleted" if getattr(data, "is_deleted", False) else body
        if len(preview) > REPLY_PREVIEW_MAX_LENGTH:
            preview = f"{preview[: REPLY_PREVIEW_MAX_LENGTH - 3]}..."

        return {
            "id": getattr(data, "id"),
            "sender": getattr(data, "sender"),
            "body_preview": preview,
            "is_deleted": getattr(data, "is_deleted"),
            "is_archived": getattr(data, "is_archived", False),
            "archived_at": getattr(data, "archived_at", None),
            "created_at": getattr(data, "created_at"),
            "attachment_count": len(attachments),
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
    is_archived: bool
    archived_at: datetime | None
    is_pinned: bool = False
    pin_id: UUID | None = None
    pinned_at: datetime | None = None
    edited_at: datetime | None
    created_at: datetime
    updated_at: datetime
    sender: UserPublic
    reply_to: MessageReplyPreviewPublic | None = None
    attachments: list[MessageAttachmentPublic] = Field(default_factory=list)
    mentions: list[MessageMentionPublic] = Field(default_factory=list)
    reactions: list[MessageReactionPublic] = Field(default_factory=list)

    @model_validator(mode="before")
    @classmethod
    def hide_deleted_message_data(cls, data: object) -> object:
        return sanitize_deleted_message(data, cls.model_fields)

    @field_validator("reactions", mode="before")
    @classmethod
    def summarize_reactions(cls, value: object, info: ValidationInfo) -> object:
        current_user_id = info.context.get("current_user_id") if info.context else None
        return aggregate_reaction_rows(value, current_user_id)


def sanitize_deleted_message(data: object, model_fields: dict[str, object]) -> object:
    is_deleted = data.get("is_deleted", False) if isinstance(data, dict) else getattr(data, "is_deleted", False)
    if not is_deleted:
        return data

    payload: dict[str, object] = {}
    for field_name in model_fields:
        if isinstance(data, dict):
            if field_name in data:
                payload[field_name] = data[field_name]
        elif hasattr(data, field_name):
            payload[field_name] = getattr(data, field_name)
    payload.update({"body": "Message deleted", "attachments": []})
    for field_name, empty_value in (
        ("mentions", []),
        ("reactions", []),
        ("reply_to", None),
        ("reply_to_message_id", None),
    ):
        if field_name in model_fields:
            payload[field_name] = empty_value
    return payload
