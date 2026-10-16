from datetime import datetime
from typing import Literal
from uuid import UUID

from pydantic import BaseModel, Field, field_validator, model_validator

from app.schemas.announcement_document import document_text, validate_document

BroadcastPriority = Literal["normal", "important", "urgent"]
BroadcastStatus = Literal["draft", "sending", "sent", "failed", "partially_failed", "retracted"]
BroadcastAudienceType = Literal["all_active_users", "selected_groups", "selected_users"]


class BroadcastAudiencePayload(BaseModel):
    audience_type: BroadcastAudienceType
    group_ids: list[UUID] = Field(default_factory=list, max_length=1000)
    user_ids: list[UUID] = Field(default_factory=list, max_length=10000)


class BroadcastCreate(BroadcastAudiencePayload):
    title: str = Field(min_length=1, max_length=160)
    body: str = Field(min_length=1, max_length=10000)
    body_doc: dict | None = None
    priority: BroadcastPriority = "normal"
    expires_at: datetime | None = None

    @field_validator("title", "body")
    @classmethod
    def strip_required_text(cls, value: str) -> str:
        stripped = value.strip()
        if not stripped:
            raise ValueError("Value cannot be empty")
        return stripped


    @model_validator(mode="after")
    def validate_formatting(self):
        if self.body_doc is not None:
            validate_document(self.body_doc)
            if document_text(self.body_doc).strip() != self.body:
                raise ValueError("Formatted document does not match announcement text")
        return self


class BroadcastUpdate(BaseModel):
    title: str | None = Field(default=None, min_length=1, max_length=160)
    body: str | None = Field(default=None, min_length=1, max_length=10000)
    body_doc: dict | None = None
    priority: BroadcastPriority | None = None
    audience_type: BroadcastAudienceType | None = None
    group_ids: list[UUID] | None = Field(default=None, max_length=1000)
    user_ids: list[UUID] | None = Field(default=None, max_length=10000)
    expires_at: datetime | None = None

    @field_validator("title", "body")
    @classmethod
    def strip_optional_text(cls, value: str | None) -> str | None:
        if value is None:
            return None
        stripped = value.strip()
        if not stripped:
            raise ValueError("Value cannot be empty")
        return stripped


    @model_validator(mode="after")
    def validate_formatting(self):
        if self.body_doc is not None:
            validate_document(self.body_doc)
            if self.body is None or document_text(self.body_doc).strip() != self.body:
                raise ValueError("Formatted document requires matching announcement text")
        return self


class BroadcastTemplateCreate(BaseModel):
    name: str = Field(min_length=1, max_length=100)
    title: str = Field(min_length=1, max_length=160)
    body: str = Field(min_length=1, max_length=10000)
    body_doc: dict | None = None
    priority: BroadcastPriority = "normal"
    model_config = {"extra": "forbid"}

    @field_validator("name", "title", "body")
    @classmethod
    def strip_text(cls, value: str):
        if not value.strip():
            raise ValueError("Value cannot be empty")
        return value.strip()

    @model_validator(mode="after")
    def validate_formatting(self):
        if self.body_doc is not None:
            validate_document(self.body_doc)
            if document_text(self.body_doc).strip() != self.body:
                raise ValueError("Formatted document does not match template text")
        return self


class BroadcastTemplatePublic(BroadcastTemplateCreate):
    id: UUID
    created_by_user_id: UUID | None
    created_by_display_name: str
    created_at: datetime
    updated_at: datetime
    model_config = {"from_attributes": True}


class BroadcastTemplatePage(BaseModel):
    items: list[BroadcastTemplatePublic]
    total: int
    page: int
    limit: int


class BroadcastPreviewRequest(BroadcastAudiencePayload):
    pass


class BroadcastPreviewPublic(BaseModel):
    recipient_count: int
    group_count: int
    excluded_disabled: int
    excluded_bots: int
    duplicates_removed: int
    audience_hash: str
    confirmation_token: str
    expires_at: datetime


class BroadcastSendRequest(BaseModel):
    confirmation_token: str = Field(min_length=1)
    expected_recipient_count: int = Field(ge=0)
    idempotency_key: str | None = Field(default=None, max_length=128)


class BroadcastPublic(BaseModel):
    id: UUID
    created_by_user_id: UUID | None
    created_by_username: str
    created_by_display_name: str
    title: str
    body: str
    body_doc: dict | None = None
    priority: BroadcastPriority
    status: BroadcastStatus
    audience_type: BroadcastAudienceType
    audience_definition: dict[str, object] | None
    recipient_count: int
    notified_count: int
    read_count: int
    failed_count: int
    sent_at: datetime | None
    expires_at: datetime | None
    retracted_at: datetime | None
    created_at: datetime
    updated_at: datetime

    model_config = {"from_attributes": True}


class BroadcastPage(BaseModel):
    items: list[BroadcastPublic]
    total: int
    page: int
    limit: int


class BroadcastStatsPublic(BaseModel):
    recipients: int
    notified: int
    offline: int
    read: int
    unread: int
    failed: int
    read_percentage: float


class AnnouncementPublic(BaseModel):
    id: UUID
    title: str
    body: str | None
    body_doc: dict | None = None
    priority: BroadcastPriority
    status: BroadcastStatus
    sender: str
    sent_at: datetime | None
    expires_at: datetime | None
    is_read: bool
    read_at: datetime | None
    dismissed_at: datetime | None
    preview: str


class AnnouncementPage(BaseModel):
    items: list[AnnouncementPublic]
    total: int
    page: int
    limit: int


class AnnouncementUnreadPublic(BaseModel):
    unread_count: int
