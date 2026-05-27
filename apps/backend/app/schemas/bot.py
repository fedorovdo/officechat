from datetime import datetime
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, model_validator

from app.schemas.message import MessageCreate
from app.schemas.user import UserPublic


SEVERITY_ICONS = {
    "disaster": "🔥",
    "high": "🚨",
    "average": "⚠️",
    "warning": "⚠️",
    "information": "ℹ️",
    "resolved": "✅",
    "recovery": "✅",
    "ok": "✅",
}
DEFAULT_BOT_ICON = "🤖"
MONITORING_FIELDS = (
    ("title", "Title"),
    ("host", "Host"),
    ("ip", "IP"),
    ("problem", "Problem"),
    ("trigger", "Trigger"),
    ("event_id", "Event ID"),
    ("url", "URL"),
    ("timestamp", "Timestamp"),
)


def clean_bot_payload_value(value: object | None) -> str:
    if value is None:
        return ""
    return str(value).strip()


class BotCreate(BaseModel):
    name: str = Field(min_length=1, max_length=160)
    description: str | None = Field(default=None, max_length=4000)


class BotUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=160)
    description: str | None = Field(default=None, max_length=4000)
    is_active: bool | None = None


class BotPublic(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: UUID
    user_id: UUID
    name: str
    description: str | None
    token_preview: str
    is_active: bool
    created_by_user_id: UUID | None
    created_at: datetime
    updated_at: datetime
    last_used_at: datetime | None
    user: UserPublic


class BotCreateResponse(BotPublic):
    token: str


class BotTokenRotateResponse(BaseModel):
    bot: BotPublic
    token: str


class IncomingBotMessage(BaseModel):
    group_id: UUID | None = None
    group_slug: str | None = Field(default=None, min_length=1, max_length=120)
    body: str = ""
    message_type: str = Field(default="text", max_length=32)
    title: str | None = Field(default=None, max_length=500)
    severity: str | None = Field(default=None, max_length=64)
    status: str | None = Field(default=None, max_length=64)
    host: str | None = Field(default=None, max_length=255)
    ip: str | None = Field(default=None, max_length=64)
    problem: str | None = Field(default=None, max_length=1000)
    trigger: str | None = Field(default=None, max_length=1000)
    event_id: str | None = Field(default=None, max_length=128)
    url: str | None = Field(default=None, max_length=2000)
    timestamp: str | None = Field(default=None, max_length=128)

    @model_validator(mode="after")
    def validate_target_group(self) -> "IncomingBotMessage":
        if self.group_id is None and not self.group_slug:
            raise ValueError("group_id or group_slug is required")
        return self

    def has_structured_alert_fields(self) -> bool:
        return any(
            clean_bot_payload_value(getattr(self, field_name))
            for field_name in (
                "title",
                "severity",
                "status",
                "host",
                "ip",
                "problem",
                "trigger",
                "event_id",
                "url",
                "timestamp",
            )
        )

    def alert_icon(self) -> str:
        status_key = clean_bot_payload_value(self.status).lower()
        if status_key in SEVERITY_ICONS:
            return SEVERITY_ICONS[status_key]

        severity_key = clean_bot_payload_value(self.severity).lower()
        return SEVERITY_ICONS.get(severity_key, DEFAULT_BOT_ICON)

    def alert_header(self) -> str:
        severity = clean_bot_payload_value(self.severity)
        status = clean_bot_payload_value(self.status)
        header_parts: list[str] = []
        if severity:
            header_parts.append(f"[{severity.upper()}]")
        if status:
            header_parts.append(status.upper())
        suffix = " ".join(header_parts)
        return f"{self.alert_icon()} {suffix}".strip()

    def to_message_create(self) -> MessageCreate:
        body = clean_bot_payload_value(self.body)
        if not self.has_structured_alert_fields():
            if not body:
                raise ValueError("Message body cannot be empty")
            return MessageCreate(body=body, message_type=self.message_type)

        body_parts: list[str] = [self.alert_header()]
        for field_name, label in MONITORING_FIELDS:
            value = clean_bot_payload_value(getattr(self, field_name))
            if value:
                body_parts.append(f"{label}: {value}")

        if body:
            if len(body_parts) > 1:
                body_parts.append("")
            body_parts.append(body)

        body = "\n".join(body_parts).strip()
        if not body.strip():
            raise ValueError("Message body cannot be empty")
        return MessageCreate(body=body, message_type=self.message_type)
