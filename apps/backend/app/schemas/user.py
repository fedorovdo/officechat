from datetime import datetime
from typing import Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, EmailStr, Field, field_validator

UserRole = Literal["superadmin", "admin", "group_owner", "moderator", "user", "bot"]


class UserPublic(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: UUID
    username: str
    display_name: str
    email: EmailStr | None
    role: UserRole
    is_active: bool
    is_system: bool
    auth_provider: str
    avatar_url: str | None
    permissions: list[str] = Field(default_factory=list)
    created_at: datetime
    updated_at: datetime
    last_login_at: datetime | None
    last_seen_at: datetime | None


class UserDirectoryEntry(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: UUID
    username: str
    display_name: str
    role: UserRole
    is_active: bool
    avatar_url: str | None
    last_seen_at: datetime | None


class PresencePublic(BaseModel):
    user_id: UUID
    status: Literal["online", "offline"]
    last_seen_at: datetime | None


class UserProfileUpdate(BaseModel):
    display_name: str = Field(min_length=1, max_length=160)

    @field_validator("display_name")
    @classmethod
    def validate_display_name(cls, value: str) -> str:
        display_name = value.strip()
        if not display_name:
            raise ValueError("Display name must not be empty")
        return display_name


class AdminUserCreate(BaseModel):
    username: str = Field(min_length=3, max_length=64)
    display_name: str = Field(min_length=1, max_length=160)
    email: EmailStr | None = None
    password: str = Field(min_length=8, max_length=256)
    role: UserRole = "user"
    is_active: bool = True


class AdminUserUpdate(BaseModel):
    display_name: str | None = Field(default=None, min_length=1, max_length=160)
    email: EmailStr | None = None
    role: UserRole | None = None
    is_active: bool | None = None


class AdminPasswordReset(BaseModel):
    new_password: str = Field(min_length=8, max_length=256)
