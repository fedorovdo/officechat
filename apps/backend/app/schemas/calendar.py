from datetime import date, datetime
from typing import Literal
from uuid import UUID

from pydantic import BaseModel, Field, ValidationInfo, field_validator

CalendarEventType = Literal["meeting", "video_conference", "office_event", "training", "maintenance", "other"]
CalendarEventStatus = Literal["scheduled", "rescheduled", "cancelled", "completed"]
CalendarAudienceType = Literal["all_active_users", "selected_groups", "selected_users"]


class CalendarAudiencePayload(BaseModel):
    audience_type: CalendarAudienceType
    group_ids: list[UUID] = Field(default_factory=list, max_length=1000)
    user_ids: list[UUID] = Field(default_factory=list, max_length=10000)


class CalendarEventBase(CalendarAudiencePayload):
    title: str = Field(min_length=1, max_length=200)
    description: str | None = Field(default=None, max_length=10000)
    event_type: CalendarEventType = "meeting"
    is_all_day: bool = False
    starts_at: datetime | None = None
    ends_at: datetime | None = None
    all_day_start_date: date | None = None
    all_day_end_date: date | None = None
    timezone: str | None = None
    location: str | None = Field(default=None, max_length=500)
    conference_url: str | None = Field(default=None, max_length=1000)
    reminder_minutes: list[int] = Field(default_factory=list, max_length=5)

    @field_validator("title")
    @classmethod
    def strip_title(cls, value: str) -> str:
        stripped = value.strip()
        if not stripped:
            raise ValueError("Title is required")
        return stripped

    @field_validator("description", "location", "conference_url")
    @classmethod
    def strip_optional(cls, value: str | None) -> str | None:
        if value is None:
            return None
        stripped = value.strip()
        return stripped or None


class CalendarEventCreate(CalendarEventBase):
    pass


class CalendarEventUpdate(BaseModel):
    title: str | None = Field(default=None, min_length=1, max_length=200)
    description: str | None = Field(default=None, max_length=10000)
    event_type: CalendarEventType | None = None
    is_all_day: bool | None = None
    starts_at: datetime | None = None
    ends_at: datetime | None = None
    all_day_start_date: date | None = None
    all_day_end_date: date | None = None
    timezone: str | None = None
    location: str | None = Field(default=None, max_length=500)
    conference_url: str | None = Field(default=None, max_length=1000)
    audience_type: CalendarAudienceType | None = None
    group_ids: list[UUID] | None = Field(default=None, max_length=1000)
    user_ids: list[UUID] | None = Field(default=None, max_length=10000)
    reminder_minutes: list[int] | None = Field(default=None, max_length=5)

    @field_validator("title", "description", "location", "conference_url")
    @classmethod
    def strip_optional(cls, value: str | None, info: ValidationInfo) -> str | None:
        if value is None:
            return None
        stripped = value.strip()
        if not stripped and info.field_name == "title":
            raise ValueError("Title is required")
        return stripped or None


class CalendarCancelRequest(BaseModel):
    reason: str | None = Field(default=None, max_length=1000)

    @field_validator("reason")
    @classmethod
    def strip_reason(cls, value: str | None) -> str | None:
        if value is None:
            return None
        stripped = value.strip()
        return stripped or None


class CalendarPreviewRequest(CalendarAudiencePayload):
    pass


class CalendarAudiencePreview(BaseModel):
    recipient_count: int
    group_count: int
    excluded_disabled: int
    excluded_bots: int
    duplicates_removed: int


class CalendarOrganizerPublic(BaseModel):
    id: UUID | None
    username: str | None
    display_name: str | None


class CalendarAudienceSummary(BaseModel):
    type: CalendarAudienceType
    recipient_count: int


class CalendarEventPublic(BaseModel):
    id: UUID
    title: str
    description: str | None
    event_type: CalendarEventType
    status: CalendarEventStatus
    is_all_day: bool
    starts_at: datetime | None
    ends_at: datetime | None
    all_day_start_date: date | None
    all_day_end_date: date | None
    timezone: str
    location: str | None
    conference_url: str | None
    created_by: CalendarOrganizerPublic
    audience_summary: CalendarAudienceSummary
    editable_audience: CalendarAudiencePayload | None = None
    reminder_minutes: list[int]
    can_manage: bool
    cancelled_at: datetime | None
    cancellation_reason: str | None
    created_at: datetime
    updated_at: datetime


class CalendarEventPage(BaseModel):
    items: list[CalendarEventPublic]
    total: int
    limit: int


class CalendarManageEventPage(CalendarEventPage):
    pass
