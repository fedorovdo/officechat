from datetime import datetime
from typing import Literal
from uuid import UUID

from pydantic import BaseModel, Field

from app.schemas.direct import DirectMessagePublic
from app.schemas.discussion import DiscussionMessagePublic
from app.schemas.message import MessagePublic


ChatType = Literal["group", "direct", "discussion"]


class MessageSearchSenderPublic(BaseModel):
    id: UUID
    username: str
    display_name: str
    avatar_url: str | None = None


class MessageSearchResultPublic(BaseModel):
    chat_type: ChatType
    chat_id: UUID
    chat_title: str
    source_group_id: UUID | None = None
    message_id: UUID
    sender: MessageSearchSenderPublic
    created_at: datetime
    excerpt: str
    attachment_count: int
    matched_attachment_names: list[str] = Field(default_factory=list)
    is_edited: bool
    reply_to_message_id: UUID | None = None


class MessageSearchPagePublic(BaseModel):
    items: list[MessageSearchResultPublic]
    next_cursor: str | None = None
    total_estimate: int | None = None


class MessageContextPublic(BaseModel):
    chat_type: ChatType
    chat_id: UUID
    target_message_id: UUID
    messages: list[MessagePublic | DirectMessagePublic | DiscussionMessagePublic]
    has_more_before: bool
    has_more_after: bool

