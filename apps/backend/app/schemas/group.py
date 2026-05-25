from datetime import datetime
from typing import Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, model_validator

from app.schemas.user import UserPublic

GroupRole = Literal["owner", "moderator", "member"]


class GroupPublic(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: UUID
    name: str
    slug: str
    description: str | None
    is_private: bool
    is_system: bool
    is_active: bool
    created_by_user_id: UUID | None
    created_at: datetime
    updated_at: datetime


class GroupCreate(BaseModel):
    name: str = Field(min_length=1, max_length=160)
    slug: str = Field(min_length=2, max_length=120)
    description: str | None = Field(default=None, max_length=4000)
    is_private: bool = True
    is_active: bool = True


class GroupUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=160)
    description: str | None = Field(default=None, max_length=4000)
    is_private: bool | None = None
    is_active: bool | None = None


class GroupMemberPublic(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: UUID
    group_id: UUID
    user_id: UUID
    role: GroupRole
    joined_at: datetime
    user: UserPublic


class GroupMemberCreate(BaseModel):
    user_id: UUID | None = None
    username: str | None = Field(default=None, min_length=1, max_length=64)
    role: GroupRole = "member"

    @model_validator(mode="after")
    def validate_user_reference(self) -> "GroupMemberCreate":
        if self.user_id is None and not self.username:
            raise ValueError("user_id or username is required")
        return self


class GroupMemberUpdate(BaseModel):
    role: GroupRole
