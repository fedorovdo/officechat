from datetime import datetime
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field

from app.schemas.user import UserPublic


class MessageCreate(BaseModel):
    body: str = Field(min_length=1)
    message_type: str = Field(default="text", max_length=32)


class MessageUpdate(BaseModel):
    body: str = Field(min_length=1)


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
