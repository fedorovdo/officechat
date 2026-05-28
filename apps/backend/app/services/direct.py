from datetime import datetime, timezone
from uuid import UUID

from sqlalchemy import or_, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.models.direct import DirectConversation, DirectMessage
from app.models.user import User
from app.schemas.direct import DirectConversationCreate, DirectMessageCreate, DirectMessageUpdate
from app.services.messages import DELETED_MESSAGE_BODY, validate_message_body
from app.services.users import get_user_by_username


def ordered_user_pair(user_a_id: UUID, user_b_id: UUID) -> tuple[UUID, UUID]:
    return (user_a_id, user_b_id) if str(user_a_id) < str(user_b_id) else (user_b_id, user_a_id)


def ensure_direct_user_can_participate(user: User) -> None:
    if not user.is_active:
        raise PermissionError("Active user required")
    if user.role == "bot":
        raise PermissionError("Bot users cannot use direct messages")


def ensure_direct_conversation_access(conversation: DirectConversation, current_user: User) -> None:
    ensure_direct_user_can_participate(current_user)
    if current_user.id not in {conversation.user_one_id, conversation.user_two_id}:
        raise PermissionError("Conversation participant required")


def get_other_user(conversation: DirectConversation, current_user: User) -> User:
    if conversation.user_one_id == current_user.id:
        return conversation.user_two
    return conversation.user_one


async def get_direct_conversation(session: AsyncSession, conversation_id: UUID) -> DirectConversation | None:
    result = await session.execute(
        select(DirectConversation)
        .options(selectinload(DirectConversation.user_one), selectinload(DirectConversation.user_two))
        .where(DirectConversation.id == conversation_id)
    )
    return result.scalar_one_or_none()


async def list_direct_conversations(session: AsyncSession, current_user: User) -> list[DirectConversation]:
    ensure_direct_user_can_participate(current_user)
    result = await session.execute(
        select(DirectConversation)
        .options(selectinload(DirectConversation.user_one), selectinload(DirectConversation.user_two))
        .where(
            or_(
                DirectConversation.user_one_id == current_user.id,
                DirectConversation.user_two_id == current_user.id,
            )
        )
        .order_by(DirectConversation.updated_at.desc())
    )
    return list(result.scalars().all())


async def get_last_direct_message(
    session: AsyncSession,
    conversation: DirectConversation,
) -> DirectMessage | None:
    result = await session.execute(
        select(DirectMessage)
        .options(selectinload(DirectMessage.sender), selectinload(DirectMessage.reply_to).selectinload(DirectMessage.sender))
        .where(DirectMessage.conversation_id == conversation.id)
        .order_by(DirectMessage.created_at.desc())
        .limit(1)
    )
    return result.scalar_one_or_none()


async def create_or_get_direct_conversation(
    session: AsyncSession,
    current_user: User,
    payload: DirectConversationCreate,
) -> DirectConversation:
    ensure_direct_user_can_participate(current_user)
    target_user = await get_user_by_username(session, payload.username.strip())
    if target_user is None:
        raise LookupError("User not found")
    ensure_direct_user_can_participate(target_user)
    if target_user.id == current_user.id:
        raise ValueError("Cannot create a direct conversation with yourself")

    user_one_id, user_two_id = ordered_user_pair(current_user.id, target_user.id)
    result = await session.execute(
        select(DirectConversation)
        .options(selectinload(DirectConversation.user_one), selectinload(DirectConversation.user_two))
        .where(
            DirectConversation.user_one_id == user_one_id,
            DirectConversation.user_two_id == user_two_id,
        )
    )
    existing_conversation = result.scalar_one_or_none()
    if existing_conversation is not None:
        return existing_conversation

    conversation = DirectConversation(user_one_id=user_one_id, user_two_id=user_two_id)
    session.add(conversation)
    await session.commit()
    return await load_direct_conversation(session, conversation.id)


async def load_direct_conversation(session: AsyncSession, conversation_id: UUID) -> DirectConversation:
    result = await session.execute(
        select(DirectConversation)
        .options(selectinload(DirectConversation.user_one), selectinload(DirectConversation.user_two))
        .where(DirectConversation.id == conversation_id)
    )
    return result.scalar_one()


async def list_direct_messages(
    session: AsyncSession,
    conversation: DirectConversation,
    limit: int,
) -> list[DirectMessage]:
    result = await session.execute(
        select(DirectMessage)
        .options(selectinload(DirectMessage.sender), selectinload(DirectMessage.reply_to).selectinload(DirectMessage.sender))
        .where(DirectMessage.conversation_id == conversation.id)
        .order_by(DirectMessage.created_at.desc())
        .limit(limit)
    )
    messages = list(result.scalars().all())
    return list(reversed(messages))


async def create_direct_message(
    session: AsyncSession,
    conversation: DirectConversation,
    current_user: User,
    payload: DirectMessageCreate,
) -> DirectMessage:
    ensure_direct_conversation_access(conversation, current_user)
    reply_to_message_id = None
    if payload.reply_to_message_id is not None:
        reply_to_message = await get_direct_message(session, conversation, payload.reply_to_message_id)
        if reply_to_message is None:
            raise ValueError("Reply target message not found in this conversation")
        reply_to_message_id = reply_to_message.id

    message = DirectMessage(
        conversation_id=conversation.id,
        sender_user_id=current_user.id,
        reply_to_message_id=reply_to_message_id,
        body=validate_message_body(payload.body),
        message_type=payload.message_type.strip() or "text",
    )
    conversation.updated_at = datetime.now(timezone.utc)
    session.add(message)
    await session.commit()
    return await load_direct_message(session, message.id)


async def get_direct_message(
    session: AsyncSession,
    conversation: DirectConversation,
    message_id: UUID,
) -> DirectMessage | None:
    result = await session.execute(
        select(DirectMessage)
        .options(selectinload(DirectMessage.sender), selectinload(DirectMessage.reply_to).selectinload(DirectMessage.sender))
        .where(DirectMessage.id == message_id, DirectMessage.conversation_id == conversation.id)
    )
    return result.scalar_one_or_none()


async def load_direct_message(session: AsyncSession, message_id: UUID) -> DirectMessage:
    result = await session.execute(
        select(DirectMessage)
        .options(selectinload(DirectMessage.sender), selectinload(DirectMessage.reply_to).selectinload(DirectMessage.sender))
        .where(DirectMessage.id == message_id)
    )
    return result.scalar_one()


async def update_direct_message(
    session: AsyncSession,
    conversation: DirectConversation,
    message: DirectMessage,
    current_user: User,
    payload: DirectMessageUpdate,
) -> DirectMessage:
    ensure_direct_conversation_access(conversation, current_user)
    if message.is_deleted:
        raise ValueError("Deleted messages cannot be edited")
    if message.sender_user_id != current_user.id:
        raise PermissionError("Only sender can edit message")

    message.body = validate_message_body(payload.body)
    message.edited_at = datetime.now(timezone.utc)
    conversation.updated_at = datetime.now(timezone.utc)
    await session.commit()
    return await load_direct_message(session, message.id)


async def delete_direct_message(
    session: AsyncSession,
    conversation: DirectConversation,
    message: DirectMessage,
    current_user: User,
) -> DirectMessage:
    ensure_direct_conversation_access(conversation, current_user)
    if message.sender_user_id != current_user.id:
        raise PermissionError("Only sender can delete message")

    message.is_deleted = True
    message.body = DELETED_MESSAGE_BODY
    conversation.updated_at = datetime.now(timezone.utc)
    await session.commit()
    return await load_direct_message(session, message.id)
