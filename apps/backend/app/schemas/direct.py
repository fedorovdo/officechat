from datetime import datetime
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field

from app.schemas.user import UserDirectoryEntry


class DirectConversationCreate(BaseModel):
    username: str = Field(min_length=1, max_length=64)


class DirectMessageCreate(BaseModel):
    body: str = Field(min_length=1)
    message_type: str = Field(default="text", max_length=32)


class DirectMessageUpdate(BaseModel):
    body: str = Field(min_length=1)


class DirectMessagePublic(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: UUID
    conversation_id: UUID
    sender_user_id: UUID
    body: str
    message_type: str
    is_deleted: bool
    edited_at: datetime | None
    created_at: datetime
    updated_at: datetime
    sender: UserDirectoryEntry


class DirectConversationPublic(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: UUID
    user_one_id: UUID
    user_two_id: UUID
    created_at: datetime
    updated_at: datetime
    other_user: UserDirectoryEntry
    last_message: DirectMessagePublic | None = None
