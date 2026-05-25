from datetime import datetime
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, model_validator

from app.schemas.message import MessageCreate
from app.schemas.user import UserPublic


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

    @model_validator(mode="after")
    def validate_target_group(self) -> "IncomingBotMessage":
        if self.group_id is None and not self.group_slug:
            raise ValueError("group_id or group_slug is required")
        return self

    def to_message_create(self) -> MessageCreate:
        body_parts: list[str] = []
        if self.title:
            title = self.title.strip()
            if self.severity:
                title = f"[{self.severity.strip().upper()}] {title}"
            body_parts.append(title)
        elif self.severity:
            body_parts.append(f"[{self.severity.strip().upper()}]")

        if self.body.strip():
            body_parts.append(self.body.strip())

        body = "\n".join(body_parts)
        if not body.strip():
            raise ValueError("Message body cannot be empty")
        return MessageCreate(body=body, message_type=self.message_type)
