from collections import defaultdict
from typing import Any
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field

from app.core.reactions import ALLOWED_REACTION_EMOJIS

class ReactionChange(BaseModel):
    emoji: str = Field(min_length=1, max_length=16)


class ReactionUserPublic(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: UUID
    username: str
    display_name: str


class MessageReactionPublic(BaseModel):
    emoji: str
    count: int
    reacted_by_me: bool
    users: list[ReactionUserPublic] = Field(default_factory=list)


def aggregate_reaction_rows(value: Any, current_user_id: UUID | str | None = None) -> list[dict[str, object]]:
    if not value:
        return []
    if isinstance(value, list) and value and isinstance(value[0], (dict, MessageReactionPublic)):
        return value

    grouped: dict[str, list[Any]] = defaultdict(list)
    for reaction in value:
        grouped[str(getattr(reaction, "emoji"))].append(reaction)

    current_user_key = str(current_user_id) if current_user_id is not None else None
    summaries: list[dict[str, object]] = []
    for emoji in ALLOWED_REACTION_EMOJIS:
        rows = grouped.get(emoji, [])
        if not rows:
            continue
        rows.sort(key=lambda row: (str(getattr(row, "created_at", "")), str(getattr(row, "id", ""))))
        summaries.append(
            {
                "emoji": emoji,
                "count": len(rows),
                "reacted_by_me": current_user_key is not None
                and any(str(getattr(row, "user_id")) == current_user_key for row in rows),
                "users": [getattr(row, "user") for row in rows],
            }
        )
    return summaries


def serialize_reactions(value: Any, current_user_id: UUID | str | None = None) -> list[MessageReactionPublic]:
    return [MessageReactionPublic.model_validate(item) for item in aggregate_reaction_rows(value, current_user_id)]
