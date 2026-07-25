from datetime import datetime
from uuid import UUID

from pydantic import BaseModel, ConfigDict, EmailStr, Field, ValidationInfo, field_validator


class DirectoryEntryBase(BaseModel):
    display_name: str = Field(min_length=1, max_length=160)
    department: str | None = Field(default=None, max_length=160)
    position: str | None = Field(default=None, max_length=160)
    internal_phone: str | None = Field(default=None, max_length=64)
    work_phone: str | None = Field(default=None, max_length=64)
    mobile_phone: str | None = Field(default=None, max_length=64)
    email: EmailStr | None = None
    room: str | None = Field(default=None, max_length=80)
    location: str | None = Field(default=None, max_length=255)
    notes: str | None = Field(default=None, max_length=2000)
    linked_user_id: UUID | None = None
    is_active: bool = True

    @field_validator(
        "display_name",
        "department",
        "position",
        "internal_phone",
        "work_phone",
        "mobile_phone",
        "room",
        "location",
        "notes",
    )
    @classmethod
    def strip_text(cls, value: str | None, info: ValidationInfo) -> str | None:
        if value is None:
            return None
        stripped = value.strip()
        if info.field_name == "display_name" and not stripped:
            raise ValueError("Display name is required")
        return stripped or None


class DirectoryEntryCreate(DirectoryEntryBase):
    pass


class DirectoryEntryUpdate(BaseModel):
    display_name: str | None = Field(default=None, min_length=1, max_length=160)
    department: str | None = Field(default=None, max_length=160)
    position: str | None = Field(default=None, max_length=160)
    internal_phone: str | None = Field(default=None, max_length=64)
    work_phone: str | None = Field(default=None, max_length=64)
    mobile_phone: str | None = Field(default=None, max_length=64)
    email: EmailStr | None = None
    room: str | None = Field(default=None, max_length=80)
    location: str | None = Field(default=None, max_length=255)
    notes: str | None = Field(default=None, max_length=2000)
    linked_user_id: UUID | None = None

    @field_validator(
        "display_name",
        "department",
        "position",
        "internal_phone",
        "work_phone",
        "mobile_phone",
        "room",
        "location",
        "notes",
    )
    @classmethod
    def strip_text(cls, value: str | None, info: ValidationInfo) -> str | None:
        if value is None:
            if info.field_name == "display_name":
                raise ValueError("Display name is required")
            return None
        stripped = value.strip()
        if info.field_name == "display_name" and not stripped:
            raise ValueError("Display name is required")
        return stripped or None


class DirectoryLinkedUserPublic(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: UUID
    username: str
    display_name: str
    is_active: bool
    role: str


class DirectoryEntryPublic(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: UUID
    display_name: str
    department: str | None
    position: str | None
    internal_phone: str | None
    work_phone: str | None
    mobile_phone: str | None
    email: EmailStr | None
    room: str | None
    location: str | None
    notes: str | None
    linked_user_id: UUID | None
    linked_user: DirectoryLinkedUserPublic | None
    is_active: bool
    created_at: datetime
    updated_at: datetime
    created_by_user_id: UUID | None
    updated_by_user_id: UUID | None


class DirectoryEntryPage(BaseModel):
    items: list[DirectoryEntryPublic]
    total: int
    page: int
    limit: int


class DirectoryDepartmentsPublic(BaseModel):
    items: list[str]
