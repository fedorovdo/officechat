import inspect
from datetime import datetime, timezone
from typing import Any, Literal
from uuid import UUID

from sqlalchemy import delete, func, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.core.config import settings
from app.core.permissions import CAN_PIN_MESSAGES
from app.models.direct import DirectConversation, DirectMessage
from app.models.discussion import Discussion, DiscussionMessage
from app.models.group import Group
from app.models.mention import MessageMention
from app.models.message import Message
from app.models.pin import PinnedMessage
from app.models.reaction import DirectMessageReaction, DiscussionMessageReaction, GroupMessageReaction
from app.models.user import User
from app.schemas.pin import (
    ChatType,
    PinCreate,
    PinMessagePreviewPublic,
    PinMessageSenderPublic,
    PinnedMessagePublic,
    PinUpdate,
    PinUserPublic,
)
from app.services.direct import ensure_direct_conversation_access, get_direct_conversation
from app.services.discussions import ensure_discussion_access, get_discussion
from app.services.groups import ensure_group_visible, get_group
from app.services.permissions import has_permission

PINNABLE_CHAT_TYPES = ("group", "direct", "discussion")
MessageLike = Message | DirectMessage | DiscussionMessage


class PinConflictError(ValueError):
    pass


def validate_pin_actor(current_user: User) -> None:
    if not current_user.is_active:
        raise PermissionError("Active user required")
    if current_user.role == "bot" or current_user.auth_provider == "bot":
        raise PermissionError("Bot users cannot pin messages")


async def require_pin_permission(session: AsyncSession, current_user: User) -> None:
    validate_pin_actor(current_user)
    if not await has_permission(session, current_user, CAN_PIN_MESSAGES):
        raise PermissionError("Permission required")


async def ensure_pin_chat_access(
    session: AsyncSession,
    chat_type: ChatType,
    chat_id: UUID,
    current_user: User,
) -> Group | DirectConversation | Discussion:
    if chat_type == "group":
        group = await get_group(session, chat_id)
        if group is None or not group.is_active:
            raise LookupError("Chat not found")
        await ensure_group_visible(session, group, current_user)
        return group

    if chat_type == "direct":
        conversation = await get_direct_conversation(session, chat_id)
        if conversation is None:
            raise LookupError("Chat not found")
        ensure_direct_conversation_access(conversation, current_user)
        return conversation

    discussion = await get_discussion(session, chat_id)
    if discussion is None:
        raise LookupError("Chat not found")
    await ensure_discussion_access(session, discussion, current_user)
    return discussion


def message_options(chat_type: ChatType):
    if chat_type == "group":
        return (
            selectinload(Message.sender),
            selectinload(Message.attachments),
            selectinload(Message.reply_to).selectinload(Message.sender),
            selectinload(Message.reply_to).selectinload(Message.attachments),
            selectinload(Message.mentions).selectinload(MessageMention.mentioned_user),
            selectinload(Message.reactions).selectinload(GroupMessageReaction.user),
        )
    if chat_type == "direct":
        return (
            selectinload(DirectMessage.sender),
            selectinload(DirectMessage.attachments),
            selectinload(DirectMessage.reply_to).selectinload(DirectMessage.sender),
            selectinload(DirectMessage.reply_to).selectinload(DirectMessage.attachments),
            selectinload(DirectMessage.reactions).selectinload(DirectMessageReaction.user),
        )
    return (
        selectinload(DiscussionMessage.sender),
        selectinload(DiscussionMessage.attachments),
        selectinload(DiscussionMessage.reactions).selectinload(DiscussionMessageReaction.user),
    )


def model_and_chat_column(chat_type: ChatType):
    if chat_type == "group":
        return Message, Message.group_id
    if chat_type == "direct":
        return DirectMessage, DirectMessage.conversation_id
    return DiscussionMessage, DiscussionMessage.discussion_id


async def get_chat_message(
    session: AsyncSession,
    chat_type: ChatType,
    chat_id: UUID,
    message_id: UUID,
) -> MessageLike | None:
    model, chat_column = model_and_chat_column(chat_type)
    result = await session.execute(
        select(model)
        .options(*message_options(chat_type))
        .where(model.id == message_id, chat_column == chat_id)
    )
    return result.scalar_one_or_none()


async def count_chat_pins(session: AsyncSession, chat_type: ChatType, chat_id: UUID) -> int:
    result = await session.execute(
        select(func.count(PinnedMessage.id)).where(
            PinnedMessage.chat_type == chat_type,
            PinnedMessage.chat_id == chat_id,
        )
    )
    return int(result.scalar_one())


async def get_pin(session: AsyncSession, pin_id: UUID) -> PinnedMessage | None:
    result = await session.execute(
        select(PinnedMessage).options(selectinload(PinnedMessage.pinned_by)).where(PinnedMessage.id == pin_id)
    )
    return result.scalar_one_or_none()


async def get_pin_by_message(
    session: AsyncSession,
    chat_type: ChatType,
    chat_id: UUID,
    message_id: UUID,
) -> PinnedMessage | None:
    result = await session.execute(
        select(PinnedMessage)
        .options(selectinload(PinnedMessage.pinned_by))
        .where(
            PinnedMessage.chat_type == chat_type,
            PinnedMessage.chat_id == chat_id,
            PinnedMessage.message_id == message_id,
        )
    )
    return result.scalar_one_or_none()


async def list_pins(session: AsyncSession, chat_type: ChatType, chat_id: UUID) -> list[PinnedMessage]:
    result = await session.execute(
        select(PinnedMessage)
        .options(selectinload(PinnedMessage.pinned_by))
        .where(PinnedMessage.chat_type == chat_type, PinnedMessage.chat_id == chat_id)
        .order_by(PinnedMessage.pinned_at.desc(), PinnedMessage.id.desc())
    )
    return list(result.scalars().all())


def message_preview(message: MessageLike) -> PinMessagePreviewPublic:
    body = str(getattr(message, "body", "") or "").strip()
    if getattr(message, "is_deleted", False):
        preview = "Message deleted"
    elif getattr(message, "is_archived", False):
        preview = ""
    else:
        preview = body
    if len(preview) > 120:
        preview = f"{preview[:117]}..."
    return PinMessagePreviewPublic(
        id=message.id,
        sender=PinMessageSenderPublic(
            id=message.sender.id,
            username=message.sender.username,
            display_name=message.sender.display_name,
        ),
        body_preview=preview,
        attachment_count=(
            0 if getattr(message, "is_deleted", False)
            else len(getattr(message, "attachments", []) or [])
        ),
        is_deleted=message.is_deleted,
        is_archived=message.is_archived,
        archived_at=message.archived_at,
        created_at=message.created_at,
    )


async def serialize_pin(session: AsyncSession, pin: PinnedMessage) -> PinnedMessagePublic:
    message = await get_chat_message(session, pin.chat_type, pin.chat_id, pin.message_id)  # type: ignore[arg-type]
    if message is None:
        raise LookupError("Pinned message not found")
    return PinnedMessagePublic(
        id=pin.id,
        chat_type=pin.chat_type,  # type: ignore[arg-type]
        chat_id=pin.chat_id,
        message_id=pin.message_id,
        note=pin.note,
        pinned_by=PinUserPublic(
            id=pin.pinned_by_user_id,
            username=pin.pinned_by.username if pin.pinned_by else pin.pinned_by_username,
            display_name=pin.pinned_by.display_name if pin.pinned_by else pin.pinned_by_display_name,
        ),
        pinned_at=pin.pinned_at,
        created_at=pin.created_at,
        updated_at=pin.updated_at,
        message=message_preview(message),
    )


async def serialize_pins(session: AsyncSession, pins: list[PinnedMessage]) -> list[PinnedMessagePublic]:
    return [await serialize_pin(session, pin) for pin in pins]


async def create_pin(session: AsyncSession, payload: PinCreate, current_user: User) -> tuple[PinnedMessage, bool]:
    await require_pin_permission(session, current_user)
    await ensure_pin_chat_access(session, payload.chat_type, payload.chat_id, current_user)
    message = await get_chat_message(session, payload.chat_type, payload.chat_id, payload.message_id)
    if message is None:
        raise LookupError("Message not found")
    if message.is_deleted:
        raise ValueError("Deleted messages cannot be pinned")
    if message.is_archived:
        raise ValueError("Archived messages cannot be pinned")

    existing = await get_pin_by_message(session, payload.chat_type, payload.chat_id, payload.message_id)
    if existing is not None:
        return existing, False
    if await count_chat_pins(session, payload.chat_type, payload.chat_id) >= settings.pinned_messages_max_per_chat:
        raise PinConflictError("Pinned message limit reached")

    now = datetime.now(timezone.utc)
    pin = PinnedMessage(
        chat_type=payload.chat_type,
        chat_id=payload.chat_id,
        message_id=payload.message_id,
        pinned_by_user_id=current_user.id,
        pinned_by_username=current_user.username,
        pinned_by_display_name=current_user.display_name,
        pinned_at=now,
        note=payload.note,
    )
    session.add(pin)
    await session.flush()
    await session.refresh(pin, ["pinned_by"])
    return pin, True


async def update_pin(
    session: AsyncSession,
    pin: PinnedMessage,
    payload: PinUpdate,
    current_user: User,
) -> PinnedMessage:
    await require_pin_permission(session, current_user)
    await ensure_pin_chat_access(session, pin.chat_type, pin.chat_id, current_user)  # type: ignore[arg-type]
    pin.note = payload.note
    await session.flush()
    await session.refresh(pin, ["pinned_by"])
    return pin


async def delete_pin(session: AsyncSession, pin: PinnedMessage, current_user: User) -> None:
    await require_pin_permission(session, current_user)
    await ensure_pin_chat_access(session, pin.chat_type, pin.chat_id, current_user)  # type: ignore[arg-type]
    await session.delete(pin)
    await session.flush()


async def delete_pins_for_message(
    session: AsyncSession,
    chat_type: ChatType,
    chat_id: UUID,
    message_id: UUID,
) -> int:
    result = await session.execute(
        delete(PinnedMessage)
        .where(
            PinnedMessage.chat_type == chat_type,
            PinnedMessage.chat_id == chat_id,
            PinnedMessage.message_id == message_id,
        )
        .returning(PinnedMessage.id)
    )
    return len(result.scalars().all())


async def delete_pins_for_messages(
    session: AsyncSession,
    chat_type: ChatType,
    message_ids: list[UUID],
) -> int:
    if not message_ids:
        return 0
    result = await session.execute(
        delete(PinnedMessage)
        .where(PinnedMessage.chat_type == chat_type, PinnedMessage.message_id.in_(message_ids))
        .returning(PinnedMessage.id)
    )
    return len(result.scalars().all())


async def annotate_messages_with_pins(
    session: AsyncSession,
    chat_type: ChatType,
    chat_id: UUID,
    messages: list[MessageLike],
) -> list[MessageLike]:
    message_ids = [message.id for message in messages]
    pin_map: dict[UUID, PinnedMessage] = {}
    if message_ids:
        result = await session.execute(
            select(PinnedMessage).where(
                PinnedMessage.chat_type == chat_type,
                PinnedMessage.chat_id == chat_id,
                PinnedMessage.message_id.in_(message_ids),
            )
        )
        scalars = result.scalars()
        if inspect.isawaitable(scalars):
            scalars = await scalars
        rows = scalars.all()
        if inspect.isawaitable(rows):
            rows = await rows
        pin_map = {pin.message_id: pin for pin in rows}

    for message in messages:
        pin = pin_map.get(message.id)
        setattr(message, "is_pinned", pin is not None)
        setattr(message, "pin_id", pin.id if pin else None)
        setattr(message, "pinned_at", pin.pinned_at if pin else None)
    return messages


async def annotate_message_context_with_pins(
    session: AsyncSession,
    chat_type: Literal["group", "direct", "discussion"],
    chat_id: UUID,
    messages: list[Any],
) -> list[Any]:
    return await annotate_messages_with_pins(session, chat_type, chat_id, messages)
