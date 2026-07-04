from datetime import datetime, timezone
from uuid import UUID

from sqlalchemy import and_, case, exists, false, func, literal, or_, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.dialects.postgresql import aggregate_order_by, insert as pg_insert
from sqlalchemy.orm import aliased

from app.models.direct import DirectConversation, DirectMessage
from app.models.discussion import Discussion, DiscussionMember, DiscussionMessage
from app.models.group import Group, GroupMember
from app.models.mention import MessageMention
from app.models.message import Message
from app.models.read_state import ChatReadState
from app.models.user import User
from app.schemas.unread import DirectReadReceiptPublic, MarkReadRequest, ReadStatePublic, UnreadChatPublic, UnreadSummaryPublic
from app.services.direct import ensure_direct_conversation_access, get_direct_conversation
from app.services.discussions import ensure_discussion_access, get_discussion
from app.services.groups import is_global_group_admin
from app.services.messages import ensure_group_message_access
from app.services.websocket_manager import direct_websocket_manager, user_websocket_manager

MESSAGE_MODELS = {
    "group": (Message, Message.group_id),
    "direct": (DirectMessage, DirectMessage.conversation_id),
    "discussion": (DiscussionMessage, DiscussionMessage.discussion_id),
}


def _after_marker(model, state):
    return or_(
        state.last_read_message_created_at.is_(None),
        model.created_at > state.last_read_message_created_at,
        and_(
            model.created_at == state.last_read_message_created_at,
            or_(state.last_read_message_id.is_(None), model.id > state.last_read_message_id),
        ),
    )


async def accessible_chat_ids(session: AsyncSession, current_user: User) -> dict[str, set[UUID]]:
    if is_global_group_admin(current_user):
        group_result = await session.execute(select(Group.id).where(Group.is_active.is_(True)))
    else:
        group_result = await session.execute(
            select(GroupMember.group_id)
            .join(Group, Group.id == GroupMember.group_id)
            .where(GroupMember.user_id == current_user.id, Group.is_active.is_(True))
        )
    direct_result = await session.execute(
        select(DirectConversation.id).where(
            or_(
                DirectConversation.user_one_id == current_user.id,
                DirectConversation.user_two_id == current_user.id,
            )
        )
    )
    discussion_result = await session.execute(
        select(DiscussionMember.discussion_id)
        .join(Discussion, Discussion.id == DiscussionMember.discussion_id)
        .join(Group, Group.id == Discussion.source_group_id)
        .where(
            DiscussionMember.user_id == current_user.id,
            Discussion.is_active.is_(True),
            Group.is_active.is_(True),
        )
    )
    return {
        "group": set(group_result.scalars().all()),
        "direct": set(direct_result.scalars().all()),
        "discussion": set(discussion_result.scalars().all()),
    }


async def _latest_messages_for_chats(
    session: AsyncSession, chat_type: str, chat_ids: set[UUID]
) -> dict[UUID, tuple[UUID, datetime]]:
    if not chat_ids:
        return {}
    model, chat_column = MESSAGE_MODELS[chat_type]
    result = await session.execute(
        select(chat_column, model.id, model.created_at)
        .where(chat_column.in_(chat_ids))
        .distinct(chat_column)
        .order_by(chat_column, model.created_at.desc(), model.id.desc())
    )
    return {chat_id: (message_id, created_at) for chat_id, message_id, created_at in result.all()}


async def initialize_missing_read_states(
    session: AsyncSession, current_user: User, accessible: dict[str, set[UUID]]
) -> bool:
    result = await session.execute(
        select(ChatReadState.chat_type, ChatReadState.chat_id).where(
            ChatReadState.user_id == current_user.id
        )
    )
    existing = {(chat_type, chat_id) for chat_type, chat_id in result.all()}
    rows: list[dict[str, object]] = []
    now = datetime.now(timezone.utc)
    for chat_type, chat_ids in accessible.items():
        missing = {chat_id for chat_id in chat_ids if (chat_type, chat_id) not in existing}
        latest = await _latest_messages_for_chats(session, chat_type, missing)
        for chat_id in missing:
            marker = latest.get(chat_id)
            rows.append({
                "user_id": current_user.id,
                "chat_type": chat_type,
                "chat_id": chat_id,
                "last_read_message_id": marker[0] if marker else None,
                "last_read_message_created_at": marker[1] if marker else None,
                "last_read_at": now,
            })
    if rows:
        await session.execute(
            pg_insert(ChatReadState)
            .values(rows)
            .on_conflict_do_nothing(index_elements=["user_id", "chat_type", "chat_id"])
        )
        await session.commit()
    return bool(rows)


async def _unread_rows(
    session: AsyncSession,
    current_user: User,
    chat_type: str,
    chat_ids: set[UUID],
) -> list[tuple[UUID, UUID, datetime, bool]]:
    if not chat_ids:
        return []
    model, chat_column = MESSAGE_MODELS[chat_type]
    state = aliased(ChatReadState)
    mentioned = (
        exists(
            select(MessageMention.id).where(
                MessageMention.message_id == model.id,
                MessageMention.mentioned_user_id == current_user.id,
            )
        )
        if chat_type == "group"
        else literal(False)
    )
    result = await session.execute(
        select(chat_column, model.id, model.created_at, mentioned)
        .join(
            state,
            and_(
                state.user_id == current_user.id,
                state.chat_type == chat_type,
                state.chat_id == chat_column,
            ),
        )
        .where(
            chat_column.in_(chat_ids),
            model.sender_user_id != current_user.id,
            model.is_deleted.is_(False),
            model.is_archived.is_(False),
            _after_marker(model, state),
        )
        .order_by(chat_column, model.created_at.asc(), model.id.asc())
    )
    return [(chat_id, message_id, created_at, bool(is_mentioned)) for chat_id, message_id, created_at, is_mentioned in result.all()]


async def get_unread_summary(session: AsyncSession, current_user: User) -> UnreadSummaryPublic:
    accessible = await accessible_chat_ids(session, current_user)
    await initialize_missing_read_states(session, current_user, accessible)
    chats: list[UnreadChatPublic] = []
    category_totals = {"group": 0, "direct": 0, "discussion": 0}
    for chat_type in ("group", "direct", "discussion"):
        aggregates: dict[UUID, dict[str, object]] = {}
        for chat_id, message_id, _, mentioned in await _unread_rows(
            session, current_user, chat_type, accessible[chat_type]
        ):
            aggregate = aggregates.setdefault(
                chat_id,
                {"count": 0, "mentions": 0, "first": message_id, "newest": message_id},
            )
            aggregate["count"] = int(aggregate["count"]) + 1
            aggregate["mentions"] = int(aggregate["mentions"]) + int(mentioned)
            aggregate["newest"] = message_id
        for chat_id, aggregate in aggregates.items():
            count = int(aggregate["count"])
            category_totals[chat_type] += count
            chats.append(
                UnreadChatPublic(
                    chat_type=chat_type,
                    chat_id=chat_id,
                    unread_count=count,
                    mention_count=int(aggregate["mentions"]),
                    first_unread_message_id=aggregate["first"],
                    newest_unread_message_id=aggregate["newest"],
                )
            )
    total = sum(category_totals.values())
    return UnreadSummaryPublic(
        total=total,
        groups=category_totals["group"],
        direct=category_totals["direct"],
        discussions=category_totals["discussion"],
        chats=chats,
    )


async def _load_authorized_message(
    session: AsyncSession, current_user: User, payload: MarkReadRequest
):
    if payload.chat_type == "group":
        group = await session.get(Group, payload.chat_id)
        if group is None:
            raise LookupError("Group not found")
        await ensure_group_message_access(session, group, current_user)
        result = await session.execute(
            select(Message).where(Message.id == payload.message_id, Message.group_id == payload.chat_id)
        )
    elif payload.chat_type == "direct":
        conversation = await get_direct_conversation(session, payload.chat_id)
        if conversation is None:
            raise LookupError("Conversation not found")
        ensure_direct_conversation_access(conversation, current_user)
        result = await session.execute(
            select(DirectMessage).where(
                DirectMessage.id == payload.message_id,
                DirectMessage.conversation_id == payload.chat_id,
            )
        )
    else:
        discussion = await get_discussion(session, payload.chat_id)
        if discussion is None:
            raise LookupError("Discussion not found")
        await ensure_discussion_access(session, discussion, current_user)
        result = await session.execute(
            select(DiscussionMessage).where(
                DiscussionMessage.id == payload.message_id,
                DiscussionMessage.discussion_id == payload.chat_id,
            )
        )
    message = result.scalar_one_or_none()
    if message is None:
        raise LookupError("Message not found in chat")
    if message.is_archived:
        raise ValueError("Archived messages are not visible in the active chat")
    return message


def _position(created_at: datetime | None, message_id: UUID | None) -> tuple[datetime, str] | None:
    if created_at is None or message_id is None:
        return None
    return created_at, str(message_id)


async def mark_chat_read(
    session: AsyncSession, current_user: User, payload: MarkReadRequest
) -> ReadStatePublic:
    message = await _load_authorized_message(session, current_user, payload)
    await session.execute(
        pg_insert(ChatReadState)
        .values(user_id=current_user.id, chat_type=payload.chat_type, chat_id=payload.chat_id)
        .on_conflict_do_nothing(index_elements=["user_id", "chat_type", "chat_id"])
    )
    result = await session.execute(
        select(ChatReadState)
        .where(
            ChatReadState.user_id == current_user.id,
            ChatReadState.chat_type == payload.chat_type,
            ChatReadState.chat_id == payload.chat_id,
        )
        .with_for_update()
    )
    state = result.scalar_one_or_none()
    if state is None:
        raise RuntimeError("Read state could not be initialized")
    now = datetime.now(timezone.utc)
    current_position = _position(state.last_read_message_created_at, state.last_read_message_id)
    requested_position = _position(message.created_at, message.id)
    if current_position is None or (requested_position is not None and requested_position > current_position):
        state.last_read_message_id = message.id
        state.last_read_message_created_at = message.created_at
        state.last_read_at = now
    await session.commit()
    await session.refresh(state)

    summary = await get_unread_summary(session, current_user)
    chat = next(
        (item for item in summary.chats if item.chat_type == payload.chat_type and item.chat_id == payload.chat_id),
        None,
    )
    event = {
        "type": "unread.updated",
        "chat_type": payload.chat_type,
        "chat_id": str(payload.chat_id),
        "unread_count": chat.unread_count if chat else 0,
        "mention_count": chat.mention_count if chat else 0,
        "total_unread": summary.total,
        "last_read_message_id": str(state.last_read_message_id) if state.last_read_message_id else None,
        "first_unread_message_id": str(chat.first_unread_message_id) if chat and chat.first_unread_message_id else None,
        "newest_unread_message_id": str(chat.newest_unread_message_id) if chat and chat.newest_unread_message_id else None,
    }
    await user_websocket_manager.broadcast_to_user(current_user.id, event)
    if payload.chat_type == "direct":
        await direct_websocket_manager.broadcast_to_conversation(
            payload.chat_id,
            {
                "type": "direct.read",
                "conversation_id": str(payload.chat_id),
                "reader_user_id": str(current_user.id),
                "last_read_message_id": str(state.last_read_message_id) if state.last_read_message_id else None,
                "last_read_message_created_at": (
                    state.last_read_message_created_at.isoformat() if state.last_read_message_created_at else None
                ),
                "read_at": state.last_read_at.isoformat() if state.last_read_at else None,
            },
        )
    return ReadStatePublic(
        chat_type=payload.chat_type,
        chat_id=payload.chat_id,
        last_read_message_id=state.last_read_message_id,
        last_read_message_created_at=state.last_read_message_created_at,
        last_read_at=state.last_read_at,
        unread_count=chat.unread_count if chat else 0,
        mention_count=chat.mention_count if chat else 0,
        total_unread=summary.total,
    )


async def get_direct_read_receipt(
    session: AsyncSession, current_user: User, conversation_id: UUID
) -> DirectReadReceiptPublic:
    conversation = await get_direct_conversation(session, conversation_id)
    if conversation is None:
        raise LookupError("Conversation not found")
    ensure_direct_conversation_access(conversation, current_user)
    other_user_id = (
        conversation.user_two_id if conversation.user_one_id == current_user.id else conversation.user_one_id
    )
    result = await session.execute(
        select(ChatReadState).where(
            ChatReadState.user_id == other_user_id,
            ChatReadState.chat_type == "direct",
            ChatReadState.chat_id == conversation_id,
        )
    )
    state = result.scalar_one_or_none()
    return DirectReadReceiptPublic(
        conversation_id=conversation_id,
        reader_user_id=other_user_id,
        last_read_message_id=state.last_read_message_id if state else None,
        last_read_message_created_at=state.last_read_message_created_at if state else None,
        read_at=state.last_read_at if state else None,
    )


async def ensure_recipient_states_before_message(
    session: AsyncSession,
    chat_type: str,
    chat_id: UUID,
    recipient_ids: list[UUID],
    message,
) -> None:
    if not recipient_ids:
        return
    result = await session.execute(
        select(ChatReadState.user_id).where(
            ChatReadState.user_id.in_(recipient_ids),
            ChatReadState.chat_type == chat_type,
            ChatReadState.chat_id == chat_id,
        )
    )
    existing = set(result.scalars().all())
    missing = set(recipient_ids) - existing
    if not missing:
        return
    model, chat_column = MESSAGE_MODELS[chat_type]
    previous = await session.execute(
        select(model.id, model.created_at)
        .where(
            chat_column == chat_id,
            or_(
                model.created_at < message.created_at,
                and_(model.created_at == message.created_at, model.id < message.id),
            ),
        )
        .order_by(model.created_at.desc(), model.id.desc())
        .limit(1)
    )
    marker = previous.one_or_none()
    await session.execute(
        pg_insert(ChatReadState)
        .values([
            {
                "user_id": user_id,
                "chat_type": chat_type,
                "chat_id": chat_id,
                "last_read_message_id": marker[0] if marker else None,
                "last_read_message_created_at": marker[1] if marker else None,
                "last_read_at": datetime.now(timezone.utc),
            }
            for user_id in missing
        ])
        .on_conflict_do_nothing(index_elements=["user_id", "chat_type", "chat_id"])
    )
    await session.commit()


async def chat_unread_counts_for_users(
    session: AsyncSession, chat_type: str, chat_id: UUID, user_ids: list[UUID]
) -> dict[UUID, tuple[int, int, UUID | None, UUID | None]]:
    counts = {user_id: (0, 0, None, None) for user_id in user_ids}
    if not user_ids:
        return counts
    model, chat_column = MESSAGE_MODELS[chat_type]
    state = aliased(ChatReadState)
    mentioned = (
        exists(
            select(MessageMention.id).where(
                MessageMention.message_id == model.id,
                MessageMention.mentioned_user_id == User.id,
            )
        )
        if chat_type == "group"
        else false()
    )
    result = await session.execute(
        select(
            User.id,
            func.count(model.id),
            func.sum(case((and_(model.id.is_not(None), mentioned), 1), else_=0)),
            func.array_agg(
                aggregate_order_by(model.id, model.created_at.asc(), model.id.asc())
            ).filter(model.id.is_not(None)),
        )
        .select_from(User)
        .outerjoin(
            state,
            and_(
                state.user_id == User.id,
                state.chat_type == chat_type,
                state.chat_id == chat_id,
            ),
        )
        .outerjoin(
            model,
            and_(
                chat_column == chat_id,
                model.sender_user_id != User.id,
                model.is_deleted.is_(False),
                model.is_archived.is_(False),
                _after_marker(model, state),
            ),
        )
        .where(User.id.in_(user_ids), User.is_active.is_(True))
        .group_by(User.id)
    )
    for user_id, unread_count, mention_count, message_ids in result.all():
        ids = list(message_ids or [])
        counts[user_id] = (
            int(unread_count or 0),
            int(mention_count or 0),
            ids[0] if ids else None,
            ids[-1] if ids else None,
        )
    return counts


async def broadcast_unread_for_chat(
    session: AsyncSession,
    chat_type: str,
    chat_id: UUID,
    recipient_ids: list[UUID],
    newest_message=None,
) -> None:
    if newest_message is not None:
        await ensure_recipient_states_before_message(
            session, chat_type, chat_id, recipient_ids, newest_message
        )
    counts = await chat_unread_counts_for_users(session, chat_type, chat_id, recipient_ids)
    for user_id, (unread_count, mention_count, first_unread, newest_unread) in counts.items():
        await user_websocket_manager.broadcast_to_user(
            user_id,
            {
                "type": "unread.updated",
                "chat_type": chat_type,
                "chat_id": str(chat_id),
                "unread_count": unread_count,
                "mention_count": mention_count,
                "total_unread": None,
                "last_read_message_id": None,
                "first_unread_message_id": str(first_unread) if first_unread else None,
                "newest_unread_message_id": str(newest_unread) if newest_unread else None,
            },
        )


async def broadcast_unread_removed(user_id: UUID, chat_type: str, chat_id: UUID) -> None:
    await user_websocket_manager.broadcast_to_user(
        user_id,
        {
            "type": "unread.updated",
            "chat_type": chat_type,
            "chat_id": str(chat_id),
            "unread_count": 0,
            "mention_count": 0,
            "total_unread": None,
            "last_read_message_id": None,
            "first_unread_message_id": None,
            "newest_unread_message_id": None,
            "removed": True,
        },
    )


async def broadcast_unread_refresh() -> None:
    for user_id in user_websocket_manager.connected_user_ids():
        await user_websocket_manager.broadcast_to_user(user_id, {"type": "unread.refresh"})
