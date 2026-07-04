import base64
import json
from dataclasses import dataclass
from datetime import datetime
from typing import Literal
from uuid import UUID

from sqlalchemy import Float, and_, case, cast, exists, func, literal, or_, select, text, union_all
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import aliased, selectinload

from app.models.attachment import DirectMessageAttachment, DiscussionMessageAttachment, MessageAttachment
from app.models.direct import DirectConversation, DirectMessage
from app.models.discussion import Discussion, DiscussionMember, DiscussionMessage
from app.models.group import Group, GroupMember
from app.models.mention import MessageMention
from app.models.message import Message
from app.models.reaction import DirectMessageReaction, DiscussionMessageReaction, GroupMessageReaction
from app.models.user import User
from app.services.direct import ensure_direct_conversation_access, get_direct_conversation
from app.services.discussions import ensure_discussion_access, get_discussion
from app.services.groups import get_group, get_group_membership

ChatType = Literal["group", "direct", "discussion"]


@dataclass(slots=True)
class MessageSearchFilters:
    query: str
    chat_type: ChatType | None = None
    chat_id: UUID | None = None
    sender_id: UUID | None = None
    date_from: datetime | None = None
    date_to: datetime | None = None
    has_attachment: bool | None = None
    limit: int = 30
    cursor: str | None = None


@dataclass(slots=True)
class MessageSearchPage:
    rows: list[object]
    next_cursor: str | None


@dataclass(slots=True)
class MessageContext:
    messages: list[object]
    has_more_before: bool
    has_more_after: bool


MESSAGE_OPTIONS = {
    "group": (
        selectinload(Message.sender),
        selectinload(Message.attachments),
        selectinload(Message.reply_to).selectinload(Message.sender),
        selectinload(Message.reply_to).selectinload(Message.attachments),
        selectinload(Message.mentions).selectinload(MessageMention.mentioned_user),
        selectinload(Message.reactions).selectinload(GroupMessageReaction.user),
    ),
    "direct": (
        selectinload(DirectMessage.sender),
        selectinload(DirectMessage.attachments),
        selectinload(DirectMessage.reply_to).selectinload(DirectMessage.sender),
        selectinload(DirectMessage.reply_to).selectinload(DirectMessage.attachments),
        selectinload(DirectMessage.reactions).selectinload(DirectMessageReaction.user),
    ),
    "discussion": (
        selectinload(DiscussionMessage.sender),
        selectinload(DiscussionMessage.attachments),
        selectinload(DiscussionMessage.reactions).selectinload(DiscussionMessageReaction.user),
    ),
}


def _attachment_expressions(attachment_model, foreign_key, message_id, ts_query, pattern):
    filename_vector = func.to_tsvector("simple", func.coalesce(attachment_model.original_filename, ""))
    filename_match = or_(
        filename_vector.op("@@")(ts_query),
        attachment_model.original_filename.ilike(pattern, escape="\\"),
    )
    has_any = exists(select(attachment_model.id).where(foreign_key == message_id))
    has_match = exists(select(attachment_model.id).where(foreign_key == message_id, filename_match))
    count = select(func.count(attachment_model.id)).where(foreign_key == message_id).scalar_subquery()
    names = (
        select(func.array_agg(attachment_model.original_filename))
        .where(foreign_key == message_id, filename_match)
        .scalar_subquery()
    )
    return has_any, has_match, count, names


def _common_filters(model, chat_column, filters: MessageSearchFilters, attachment_exists):
    clauses = [model.is_deleted.is_(False), model.is_archived.is_(False)]
    if filters.chat_id is not None:
        clauses.append(chat_column == filters.chat_id)
    if filters.sender_id is not None:
        clauses.append(model.sender_user_id == filters.sender_id)
    if filters.date_from is not None:
        clauses.append(model.created_at >= filters.date_from)
    if filters.date_to is not None:
        clauses.append(model.created_at <= filters.date_to)
    if filters.has_attachment is True:
        clauses.append(attachment_exists)
    elif filters.has_attachment is False:
        clauses.append(~attachment_exists)
    return clauses


def _search_columns(
    *,
    chat_type: ChatType,
    chat_id,
    chat_title,
    source_group_id,
    model,
    sender,
    attachment_count,
    attachment_names,
    rank,
):
    return (
        literal(chat_type).label("chat_type"),
        chat_id.label("chat_id"),
        chat_title.label("chat_title"),
        source_group_id.label("source_group_id"),
        model.id.label("message_id"),
        sender.id.label("sender_id"),
        sender.username.label("sender_username"),
        sender.display_name.label("sender_display_name"),
        sender.avatar_path.label("sender_avatar_path"),
        model.created_at.label("created_at"),
        model.body.label("body"),
        attachment_count.label("attachment_count"),
        attachment_names.label("matched_attachment_names"),
        (model.edited_at.is_not(None)).label("is_edited"),
        getattr(
            model,
            "reply_to_message_id",
            cast(literal(None), model.id.type),
        ).label("reply_to_message_id"),
        cast(rank, Float).label("rank"),
    )


def _group_search(filters: MessageSearchFilters, current_user: User, ts_query, pattern):
    sender = aliased(User)
    has_attachment, attachment_match, attachment_count, attachment_names = _attachment_expressions(
        MessageAttachment, MessageAttachment.message_id, Message.id, ts_query, pattern
    )
    body_vector = func.to_tsvector("simple", func.coalesce(Message.body, ""))
    body_match = body_vector.op("@@")(ts_query)
    sender_match = or_(
        sender.username.ilike(pattern, escape="\\"),
        sender.display_name.ilike(pattern, escape="\\"),
    )
    exact = Message.body.ilike(pattern, escape="\\")
    rank = (
        func.ts_rank_cd(body_vector, ts_query)
        + case((exact, 2.0), else_=0.0)
        + case((sender_match, 0.4), else_=0.0)
        + case((attachment_match, 0.3), else_=0.0)
    )
    membership = exists(
        select(GroupMember.id).where(
            GroupMember.group_id == Message.group_id,
            GroupMember.user_id == current_user.id,
        )
    )
    return (
        select(
            *_search_columns(
                chat_type="group",
                chat_id=Message.group_id,
                chat_title=Group.name,
                source_group_id=cast(literal(None), Message.group_id.type),
                model=Message,
                sender=sender,
                attachment_count=attachment_count,
                attachment_names=attachment_names,
                rank=rank,
            )
        )
        .select_from(Message)
        .join(Group, Group.id == Message.group_id)
        .join(sender, sender.id == Message.sender_user_id)
        .where(
            Group.is_active.is_(True),
            membership,
            or_(body_match, sender_match, attachment_match),
            *_common_filters(Message, Message.group_id, filters, has_attachment),
        )
    )


def _direct_search(filters: MessageSearchFilters, current_user: User, ts_query, pattern):
    sender = aliased(User)
    user_one = aliased(User)
    user_two = aliased(User)
    has_attachment, attachment_match, attachment_count, attachment_names = _attachment_expressions(
        DirectMessageAttachment,
        DirectMessageAttachment.direct_message_id,
        DirectMessage.id,
        ts_query,
        pattern,
    )
    body_vector = func.to_tsvector("simple", func.coalesce(DirectMessage.body, ""))
    body_match = body_vector.op("@@")(ts_query)
    sender_match = or_(
        sender.username.ilike(pattern, escape="\\"),
        sender.display_name.ilike(pattern, escape="\\"),
    )
    rank = (
        func.ts_rank_cd(body_vector, ts_query)
        + case((DirectMessage.body.ilike(pattern, escape="\\"), 2.0), else_=0.0)
        + case((sender_match, 0.4), else_=0.0)
        + case((attachment_match, 0.3), else_=0.0)
    )
    title = case(
        (DirectConversation.user_one_id == current_user.id, user_two.display_name),
        else_=user_one.display_name,
    )
    return (
        select(
            *_search_columns(
                chat_type="direct",
                chat_id=DirectMessage.conversation_id,
                chat_title=title,
                source_group_id=cast(literal(None), DirectMessage.conversation_id.type),
                model=DirectMessage,
                sender=sender,
                attachment_count=attachment_count,
                attachment_names=attachment_names,
                rank=rank,
            )
        )
        .select_from(DirectMessage)
        .join(DirectConversation, DirectConversation.id == DirectMessage.conversation_id)
        .join(user_one, user_one.id == DirectConversation.user_one_id)
        .join(user_two, user_two.id == DirectConversation.user_two_id)
        .join(sender, sender.id == DirectMessage.sender_user_id)
        .where(
            or_(
                DirectConversation.user_one_id == current_user.id,
                DirectConversation.user_two_id == current_user.id,
            ),
            or_(body_match, sender_match, attachment_match),
            *_common_filters(
                DirectMessage, DirectMessage.conversation_id, filters, has_attachment
            ),
        )
    )


def _discussion_search(filters: MessageSearchFilters, current_user: User, ts_query, pattern):
    sender = aliased(User)
    has_attachment, attachment_match, attachment_count, attachment_names = _attachment_expressions(
        DiscussionMessageAttachment,
        DiscussionMessageAttachment.discussion_message_id,
        DiscussionMessage.id,
        ts_query,
        pattern,
    )
    body_vector = func.to_tsvector("simple", func.coalesce(DiscussionMessage.body, ""))
    body_match = body_vector.op("@@")(ts_query)
    sender_match = or_(
        sender.username.ilike(pattern, escape="\\"),
        sender.display_name.ilike(pattern, escape="\\"),
    )
    rank = (
        func.ts_rank_cd(body_vector, ts_query)
        + case((DiscussionMessage.body.ilike(pattern, escape="\\"), 2.0), else_=0.0)
        + case((sender_match, 0.4), else_=0.0)
        + case((attachment_match, 0.3), else_=0.0)
    )
    membership = exists(
        select(DiscussionMember.id).where(
            DiscussionMember.discussion_id == DiscussionMessage.discussion_id,
            DiscussionMember.user_id == current_user.id,
        )
    )
    title = func.coalesce(Discussion.title, Group.name)
    return (
        select(
            *_search_columns(
                chat_type="discussion",
                chat_id=DiscussionMessage.discussion_id,
                chat_title=title,
                source_group_id=Discussion.source_group_id,
                model=DiscussionMessage,
                sender=sender,
                attachment_count=attachment_count,
                attachment_names=attachment_names,
                rank=rank,
            )
        )
        .select_from(DiscussionMessage)
        .join(Discussion, Discussion.id == DiscussionMessage.discussion_id)
        .join(Group, Group.id == Discussion.source_group_id)
        .join(sender, sender.id == DiscussionMessage.sender_user_id)
        .where(
            Discussion.is_active.is_(True),
            Group.is_active.is_(True),
            membership,
            or_(body_match, sender_match, attachment_match),
            *_common_filters(
                DiscussionMessage, DiscussionMessage.discussion_id, filters, has_attachment
            ),
        )
    )


def _encode_cursor(rank: float, created_at: datetime, message_id: UUID) -> str:
    payload = json.dumps(
        {"rank": rank, "created_at": created_at.isoformat(), "message_id": str(message_id)},
        separators=(",", ":"),
    ).encode()
    return base64.urlsafe_b64encode(payload).decode().rstrip("=")


def _decode_cursor(cursor: str) -> tuple[float, datetime, UUID]:
    try:
        padding = "=" * (-len(cursor) % 4)
        payload = json.loads(base64.urlsafe_b64decode(cursor + padding))
        return float(payload["rank"]), datetime.fromisoformat(payload["created_at"]), UUID(payload["message_id"])
    except (ValueError, TypeError, KeyError, json.JSONDecodeError) as exc:
        raise ValueError("Invalid search cursor") from exc


def make_excerpt(body: str, query: str, maximum: int = 220) -> str:
    normalized = " ".join(body.split())
    if len(normalized) <= maximum:
        return normalized
    folded = normalized.casefold()
    terms = [query.casefold(), *query.casefold().split()]
    index = next((folded.find(term) for term in terms if term and folded.find(term) >= 0), 0)
    start = max(0, index - maximum // 3)
    end = min(len(normalized), start + maximum)
    start = max(0, end - maximum)
    return f"{'...' if start else ''}{normalized[start:end]}{'...' if end < len(normalized) else ''}"


async def search_messages(
    session: AsyncSession, current_user: User, filters: MessageSearchFilters
) -> MessageSearchPage:
    await session.execute(text("SET LOCAL statement_timeout = '5000ms'"))
    ts_query = func.plainto_tsquery("simple", filters.query)
    escaped_query = filters.query.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
    pattern = f"%{escaped_query}%"
    builders = {
        "group": _group_search,
        "direct": _direct_search,
        "discussion": _discussion_search,
    }
    branches = [builders[filters.chat_type](filters, current_user, ts_query, pattern)] if filters.chat_type else [
        builder(filters, current_user, ts_query, pattern) for builder in builders.values()
    ]
    candidates = union_all(*branches).subquery("message_search_candidates")
    query = select(candidates)
    if filters.cursor:
        cursor_rank, cursor_created_at, cursor_id = _decode_cursor(filters.cursor)
        query = query.where(
            or_(
                candidates.c.rank < cursor_rank,
                and_(candidates.c.rank == cursor_rank, candidates.c.created_at < cursor_created_at),
                and_(
                    candidates.c.rank == cursor_rank,
                    candidates.c.created_at == cursor_created_at,
                    candidates.c.message_id < cursor_id,
                ),
            )
        )
    query = query.order_by(
        candidates.c.rank.desc(), candidates.c.created_at.desc(), candidates.c.message_id.desc()
    ).limit(filters.limit + 1)
    rows = list((await session.execute(query)).mappings().all())
    has_more = len(rows) > filters.limit
    rows = rows[: filters.limit]
    next_cursor = None
    if has_more and rows:
        last = rows[-1]
        next_cursor = _encode_cursor(float(last["rank"]), last["created_at"], last["message_id"])
    return MessageSearchPage(rows=rows, next_cursor=next_cursor)


async def ensure_search_chat_access(
    session: AsyncSession, current_user: User, chat_type: ChatType, chat_id: UUID
):
    if chat_type == "group":
        group = await get_group(session, chat_id)
        if group is None or not group.is_active:
            raise LookupError("Chat or message not found")
        if await get_group_membership(session, chat_id, current_user.id) is None:
            raise PermissionError("Chat access denied")
        return group
    if chat_type == "direct":
        conversation = await get_direct_conversation(session, chat_id)
        if conversation is None:
            raise LookupError("Chat or message not found")
        ensure_direct_conversation_access(conversation, current_user)
        return conversation
    discussion = await get_discussion(session, chat_id)
    if discussion is None:
        raise LookupError("Chat or message not found")
    await ensure_discussion_access(session, discussion, current_user)
    return discussion


async def get_message_context(
    session: AsyncSession,
    current_user: User,
    chat_type: ChatType,
    chat_id: UUID,
    message_id: UUID,
    before: int,
    after: int,
) -> MessageContext:
    await ensure_search_chat_access(session, current_user, chat_type, chat_id)
    model, chat_column = {
        "group": (Message, Message.group_id),
        "direct": (DirectMessage, DirectMessage.conversation_id),
        "discussion": (DiscussionMessage, DiscussionMessage.discussion_id),
    }[chat_type]
    target_result = await session.execute(
        select(model)
        .options(*MESSAGE_OPTIONS[chat_type])
        .where(model.id == message_id, chat_column == chat_id, model.is_archived.is_(False))
    )
    target = target_result.scalar_one_or_none()
    if target is None:
        raise LookupError("Chat or message not found")
    before_rows = list(
        (await session.execute(
            select(model)
            .options(*MESSAGE_OPTIONS[chat_type])
            .where(
                chat_column == chat_id,
                model.is_archived.is_(False),
                or_(
                    model.created_at < target.created_at,
                    and_(model.created_at == target.created_at, model.id < target.id),
                ),
            )
            .order_by(model.created_at.desc(), model.id.desc())
            .limit(before + 1)
        )).scalars().all()
    )
    after_rows = list(
        (await session.execute(
            select(model)
            .options(*MESSAGE_OPTIONS[chat_type])
            .where(
                chat_column == chat_id,
                model.is_archived.is_(False),
                or_(
                    model.created_at > target.created_at,
                    and_(model.created_at == target.created_at, model.id > target.id),
                ),
            )
            .order_by(model.created_at.asc(), model.id.asc())
            .limit(after + 1)
        )).scalars().all()
    )
    return MessageContext(
        messages=[*reversed(before_rows[:before]), target, *after_rows[:after]],
        has_more_before=len(before_rows) > before,
        has_more_after=len(after_rows) > after,
    )
