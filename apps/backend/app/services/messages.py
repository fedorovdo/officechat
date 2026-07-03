from datetime import datetime, timezone
from uuid import UUID

from sqlalchemy import and_, or_, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.core.config import settings
from app.models.group import Group
from app.models.mention import MessageMention
from app.models.message import Message
from app.models.reaction import GroupMessageReaction
from app.models.user import User
from app.schemas.message import MessageCreate, MessageUpdate
from app.services.groups import get_group_membership, is_global_group_admin
from app.services.mentions import sync_message_mentions

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
        .options(
            selectinload(Message.sender),
            selectinload(Message.attachments),
            selectinload(Message.reply_to).selectinload(Message.sender),
            selectinload(Message.reply_to).selectinload(Message.attachments),
            selectinload(Message.mentions).selectinload(MessageMention.mentioned_user),
            selectinload(Message.reactions).selectinload(GroupMessageReaction.user),
        )
        .where(Message.group_id == group.id, Message.is_archived.is_(False))
        .order_by(Message.created_at.desc(), Message.id.desc())
        .limit(limit)
    )
    if before is not None:
        before_message = await get_group_message(session, group, before)
        if before_message is not None:
            query = query.where(
                or_(
                    Message.created_at < before_message.created_at,
                    and_(Message.created_at == before_message.created_at, Message.id < before_message.id),
                )
            )

    result = await session.execute(query)
    messages = list(result.scalars().all())
    return list(reversed(messages))


async def list_archived_group_messages(
    session: AsyncSession,
    group: Group,
    limit: int,
    before: UUID | None = None,
) -> list[Message]:
    query = (
        select(Message)
        .options(
            selectinload(Message.sender),
            selectinload(Message.attachments),
            selectinload(Message.reply_to).selectinload(Message.sender),
            selectinload(Message.reply_to).selectinload(Message.attachments),
            selectinload(Message.mentions).selectinload(MessageMention.mentioned_user),
            selectinload(Message.reactions).selectinload(GroupMessageReaction.user),
        )
        .where(Message.group_id == group.id, Message.is_archived.is_(True))
        .order_by(Message.created_at.desc(), Message.id.desc())
        .limit(limit)
    )
    if before is not None:
        cursor = await get_group_message(session, group, before)
        if cursor is not None:
            query = query.where(
                or_(
                    Message.created_at < cursor.created_at,
                    and_(Message.created_at == cursor.created_at, Message.id < cursor.id),
                )
            )
    result = await session.execute(query)
    return list(result.scalars().all())


async def create_group_message(
    session: AsyncSession,
    group: Group,
    current_user: User,
    payload: MessageCreate,
) -> Message:
    reply_to_message_id = None
    if payload.reply_to_message_id is not None:
        reply_to_message = await get_group_message(session, group, payload.reply_to_message_id)
        if reply_to_message is None:
            raise ValueError("Reply target message not found in this group")
        if reply_to_message.is_archived:
            raise ValueError("Archived messages cannot receive new replies")
        reply_to_message_id = reply_to_message.id

    message = Message(
        group_id=group.id,
        sender_user_id=current_user.id,
        reply_to_message_id=reply_to_message_id,
        body=validate_message_body(payload.body),
        message_type=payload.message_type.strip() or "text",
    )
    session.add(message)
    await session.flush()
    await sync_message_mentions(session, message)
    await session.commit()
    await session.refresh(message)
    return await load_message_with_sender(session, message.id)


async def get_group_message(session: AsyncSession, group: Group, message_id: UUID) -> Message | None:
    result = await session.execute(
        select(Message)
        .options(
            selectinload(Message.sender),
            selectinload(Message.attachments),
            selectinload(Message.reply_to).selectinload(Message.sender),
            selectinload(Message.reply_to).selectinload(Message.attachments),
            selectinload(Message.mentions).selectinload(MessageMention.mentioned_user),
            selectinload(Message.reactions).selectinload(GroupMessageReaction.user),
        )
        .where(Message.id == message_id, Message.group_id == group.id)
    )
    return result.scalar_one_or_none()


async def load_message_with_sender(session: AsyncSession, message_id: UUID) -> Message:
    result = await session.execute(
        select(Message)
        .options(
            selectinload(Message.sender),
            selectinload(Message.attachments),
            selectinload(Message.reply_to).selectinload(Message.sender),
            selectinload(Message.reply_to).selectinload(Message.attachments),
            selectinload(Message.mentions).selectinload(MessageMention.mentioned_user),
            selectinload(Message.reactions).selectinload(GroupMessageReaction.user),
        )
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
    if message.is_archived:
        raise ValueError("Archived messages cannot be edited")
    if message.sender_user_id != current_user.id:
        raise PermissionError("Only sender can edit message")

    message.body = validate_message_body(payload.body)
    message.edited_at = datetime.now(timezone.utc)
    await sync_message_mentions(session, message)
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
    if message.is_archived:
        raise ValueError("Archived messages are read-only")

    message.is_deleted = True
    message.body = DELETED_MESSAGE_BODY
    await session.commit()
    await session.refresh(message)
    return await load_message_with_sender(session, message.id)
