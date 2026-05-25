from datetime import datetime
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, computed_field

from app.schemas.user import UserPublic


class MessageCreate(BaseModel):
    body: str = Field(min_length=1)
    message_type: str = Field(default="text", max_length=32)


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


class MessagePublic(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: UUID
    group_id: UUID
    sender_user_id: UUID
    body: str
    message_type: str
    is_deleted: bool
    edited_at: datetime | None
    created_at: datetime
    updated_at: datetime
    sender: UserPublic
    attachments: list[MessageAttachmentPublic] = Field(default_factory=list)
