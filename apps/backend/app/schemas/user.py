from datetime import datetime
from typing import Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, EmailStr, Field

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
    created_at: datetime
    updated_at: datetime
    last_login_at: datetime | None


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
