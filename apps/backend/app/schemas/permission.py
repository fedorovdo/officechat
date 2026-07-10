from datetime import datetime
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field


class PermissionPublic(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    key: str
    category: str
    description_ru: str
    description_en: str
    is_active: bool
    created_at: datetime
    updated_at: datetime


class UserPermissionState(BaseModel):
    explicit_permissions: list[str]
    effective_permissions: list[str]
    inherited_from_superadmin: bool


class UserPermissionsUpdate(BaseModel):
    permissions: list[str] = Field(default_factory=list, max_length=50)


class UserPermissionGrantPublic(BaseModel):
    id: UUID
    user_id: UUID
    permission_key: str
    granted_by_user_id: UUID | None
    granted_at: datetime
    updated_at: datetime
