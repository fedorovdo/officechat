from datetime import datetime, timezone
from uuid import UUID

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.core.config import settings
from app.models.group import Group
from app.models.message import Message
from app.models.user import User
from app.schemas.message import MessageCreate, MessageUpdate
from app.services.groups import get_group_membership, is_global_group_admin

DELETED_MESSAGE_BODY = "Message deleted"
GROUP_MESSAGE_MANAGERS = {"owner", "moderator"}


async def ensure_group_message_access(session: AsyncSession, group: Group, current_user: User) -> None:
    if not group.is_active:
        raise PermissionError("Group is inactive")
    if is_global_group_admin(current_user):
        return
    membership = await get_group_membership(session, group.id, current_user.id)
    if membership is None:
        raise PermissionError("Group membership required")


def validate_message_body(body: str) -> str:
    normalized_body = body.strip()
    if not normalized_body:
        raise ValueError("Message body cannot be empty")
    if len(normalized_body) > settings.message_max_length:
        raise ValueError(f"Message body cannot exceed {settings.message_max_length} characters")
    return normalized_body


async def list_group_messages(
    session: AsyncSession,
    group: Group,
    limit: int,
    before: UUID | None = None,
) -> list[Message]:
    query = (
        select(Message)
        .options(selectinload(Message.sender), selectinload(Message.attachments))
        .where(Message.group_id == group.id)
        .order_by(Message.created_at.desc())
        .limit(limit)
    )
    if before is not None:
        before_message = await get_group_message(session, group, before)
        if before_message is not None:
            query = query.where(Message.created_at < before_message.created_at)

    result = await session.execute(query)
    messages = list(result.scalars().all())
    return list(reversed(messages))


async def create_group_message(
    session: AsyncSession,
    group: Group,
    current_user: User,
    payload: MessageCreate,
) -> Message:
    message = Message(
        group_id=group.id,
        sender_user_id=current_user.id,
        body=validate_message_body(payload.body),
        message_type=payload.message_type.strip() or "text",
    )
    session.add(message)
    await session.commit()
    await session.refresh(message)
    return await load_message_with_sender(session, message.id)


async def get_group_message(session: AsyncSession, group: Group, message_id: UUID) -> Message | None:
    result = await session.execute(
        select(Message)
        .options(selectinload(Message.sender), selectinload(Message.attachments))
        .where(Message.id == message_id, Message.group_id == group.id)
    )
    return result.scalar_one_or_none()


async def load_message_with_sender(session: AsyncSession, message_id: UUID) -> Message:
    result = await session.execute(
        select(Message)
        .options(selectinload(Message.sender), selectinload(Message.attachments))
        .where(Message.id == message_id)
    )
    return result.scalar_one()


async def update_group_message(
    session: AsyncSession,
    message: Message,
    current_user: User,
    payload: MessageUpdate,
) -> Message:
    if message.is_deleted:
        raise ValueError("Deleted messages cannot be edited")
    if message.sender_user_id != current_user.id:
        raise PermissionError("Only sender can edit message")

    message.body = validate_message_body(payload.body)
    message.edited_at = datetime.now(timezone.utc)
    await session.commit()
    await session.refresh(message)
    return await load_message_with_sender(session, message.id)


async def can_delete_message(session: AsyncSession, group: Group, message: Message, current_user: User) -> bool:
    if is_global_group_admin(current_user) or message.sender_user_id == current_user.id:
        return True
    membership = await get_group_membership(session, group.id, current_user.id)
    return membership is not None and membership.role in GROUP_MESSAGE_MANAGERS


async def delete_group_message(
    session: AsyncSession,
    group: Group,
    message: Message,
    current_user: User,
) -> Message:
    if not await can_delete_message(session, group, message, current_user):
        raise PermissionError("Message delete access denied")

    message.is_deleted = True
    message.body = DELETED_MESSAGE_BODY
    await session.commit()
    await session.refresh(message)
    return await load_message_with_sender(session, message.id)
