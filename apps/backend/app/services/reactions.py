import uuid
from typing import Any
from uuid import UUID

from sqlalchemy import delete, select
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.core.reactions import ALLOWED_REACTION_EMOJIS
from app.models.reaction import DirectMessageReaction, DiscussionMessageReaction, GroupMessageReaction
from app.models.user import User


def validate_reaction_emoji(emoji: str) -> str:
    if emoji not in ALLOWED_REACTION_EMOJIS:
        raise ValueError("Unsupported reaction emoji")
    return emoji


def ensure_active_reaction_user(current_user: User) -> None:
    if not current_user.is_active:
        raise PermissionError("Active user required")


async def _list_reactions(session: AsyncSession, model: Any, message_id: UUID) -> list[Any]:
    result = await session.execute(
        select(model)
        .options(selectinload(model.user))
        .where(model.message_id == message_id)
        .order_by(model.created_at.asc(), model.id.asc())
    )
    return list(result.scalars().all())


async def _add_reaction(
    session: AsyncSession,
    model: Any,
    message_id: UUID,
    current_user: User,
    emoji: str,
    is_deleted: bool,
) -> list[Any]:
    ensure_active_reaction_user(current_user)
    normalized_emoji = validate_reaction_emoji(emoji)
    if is_deleted:
        raise ValueError("Deleted messages cannot receive new reactions")

    statement = (
        insert(model)
        .values(id=uuid.uuid4(), message_id=message_id, user_id=current_user.id, emoji=normalized_emoji)
        .on_conflict_do_nothing(index_elements=["message_id", "user_id", "emoji"])
    )
    await session.execute(statement)
    await session.commit()
    return await _list_reactions(session, model, message_id)


async def _remove_reaction(
    session: AsyncSession,
    model: Any,
    message_id: UUID,
    current_user: User,
    emoji: str,
) -> list[Any]:
    ensure_active_reaction_user(current_user)
    normalized_emoji = validate_reaction_emoji(emoji)
    await session.execute(
        delete(model).where(
            model.message_id == message_id,
            model.user_id == current_user.id,
            model.emoji == normalized_emoji,
        )
    )
    await session.commit()
    return await _list_reactions(session, model, message_id)


async def add_group_message_reaction(
    session: AsyncSession, message_id: UUID, current_user: User, emoji: str, is_deleted: bool
) -> list[GroupMessageReaction]:
    return await _add_reaction(session, GroupMessageReaction, message_id, current_user, emoji, is_deleted)


async def remove_group_message_reaction(
    session: AsyncSession, message_id: UUID, current_user: User, emoji: str
) -> list[GroupMessageReaction]:
    return await _remove_reaction(session, GroupMessageReaction, message_id, current_user, emoji)


async def add_direct_message_reaction(
    session: AsyncSession, message_id: UUID, current_user: User, emoji: str, is_deleted: bool
) -> list[DirectMessageReaction]:
    return await _add_reaction(session, DirectMessageReaction, message_id, current_user, emoji, is_deleted)


async def remove_direct_message_reaction(
    session: AsyncSession, message_id: UUID, current_user: User, emoji: str
) -> list[DirectMessageReaction]:
    return await _remove_reaction(session, DirectMessageReaction, message_id, current_user, emoji)


async def add_discussion_message_reaction(
    session: AsyncSession, message_id: UUID, current_user: User, emoji: str, is_deleted: bool
) -> list[DiscussionMessageReaction]:
    return await _add_reaction(session, DiscussionMessageReaction, message_id, current_user, emoji, is_deleted)


async def remove_discussion_message_reaction(
    session: AsyncSession, message_id: UUID, current_user: User, emoji: str
) -> list[DiscussionMessageReaction]:
    return await _remove_reaction(session, DiscussionMessageReaction, message_id, current_user, emoji)

