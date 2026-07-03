from datetime import datetime
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, field_validator


class AuditEventPublic(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: UUID
    actor_user_id: UUID | None
    actor_username: str | None
    actor_display_name: str | None
    actor_role: str | None
    event_type: str
    category: str
    action: str
    status: str
    target_type: str | None
    target_id: str | None
    target_label: str | None
    source_ip: str | None
    user_agent: str | None
    request_id: str | None
    details: dict | None
    error_code: str | None
    error_message: str | None
    created_at: datetime

    @field_validator("details", mode="before")
    @classmethod
    def sanitize_details(cls, value: object) -> object:
        if value is None:
            return None
        from app.services.audit import sanitize_audit_value

        return sanitize_audit_value(value)


class AuditEventPage(BaseModel):
    items: list[AuditEventPublic]
    total: int
    page: int
    limit: int


class AuditFilterOptions(BaseModel):
    categories: list[str] = Field(default_factory=list)
    statuses: list[str] = Field(default_factory=list)
    event_types: list[str] = Field(default_factory=list)
