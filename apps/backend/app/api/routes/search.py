from datetime import datetime
from typing import Annotated, Literal
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import get_current_user, get_db
from app.models.user import User
from app.schemas.direct import DirectMessagePublic
from app.schemas.discussion import DiscussionMessagePublic
from app.schemas.message import MessagePublic
from app.schemas.search import (
    MessageContextPublic,
    MessageSearchPagePublic,
    MessageSearchResultPublic,
    MessageSearchSenderPublic,
)
from app.services.message_search import (
    MessageSearchFilters,
    get_message_context,
    make_excerpt,
    search_messages,
)
from app.services.pins import annotate_message_context_with_pins

router = APIRouter()
ChatType = Literal["group", "direct", "discussion"]


@router.get("/messages", response_model=MessageSearchPagePublic)
async def message_search(
    session: Annotated[AsyncSession, Depends(get_db)],
    current_user: Annotated[User, Depends(get_current_user)],
    q: Annotated[str, Query(min_length=2, max_length=200)],
    chat_type: ChatType | None = None,
    chat_id: UUID | None = None,
    sender_id: UUID | None = None,
    date_from: datetime | None = None,
    date_to: datetime | None = None,
    has_attachment: bool | None = None,
    limit: Annotated[int, Query(ge=1, le=100)] = 30,
    cursor: str | None = None,
) -> MessageSearchPagePublic:
    query = q.strip()
    if len(query) < 2:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="Search query is too short")
    if chat_id is not None and chat_type is None:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="chat_type is required with chat_id")
    if date_from is not None and date_to is not None and date_from > date_to:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="Invalid date range")
    try:
        page = await search_messages(
            session,
            current_user,
            MessageSearchFilters(
                query=query,
                chat_type=chat_type,
                chat_id=chat_id,
                sender_id=sender_id,
                date_from=date_from,
                date_to=date_to,
                has_attachment=has_attachment,
                limit=limit,
                cursor=cursor,
            ),
        )
    except ValueError as exc:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail=str(exc)) from exc

    return MessageSearchPagePublic(
        items=[
            MessageSearchResultPublic(
                chat_type=row["chat_type"],
                chat_id=row["chat_id"],
                chat_title=row["chat_title"],
                source_group_id=row["source_group_id"],
                message_id=row["message_id"],
                sender=MessageSearchSenderPublic(
                    id=row["sender_id"],
                    username=row["sender_username"],
                    display_name=row["sender_display_name"],
                    avatar_url=(
                        f"/api/users/{row['sender_id']}/avatar" if row["sender_avatar_path"] else None
                    ),
                ),
                created_at=row["created_at"],
                excerpt=make_excerpt(row["body"], query),
                attachment_count=int(row["attachment_count"] or 0),
                matched_attachment_names=list(row["matched_attachment_names"] or []),
                is_edited=bool(row["is_edited"]),
                reply_to_message_id=row["reply_to_message_id"],
            )
            for row in page.rows
        ],
        next_cursor=page.next_cursor,
    )


@router.get("/context", response_model=MessageContextPublic)
async def message_context(
    session: Annotated[AsyncSession, Depends(get_db)],
    current_user: Annotated[User, Depends(get_current_user)],
    chat_type: ChatType,
    chat_id: UUID,
    message_id: UUID,
    before: Annotated[int, Query(ge=0, le=100)] = 20,
    after: Annotated[int, Query(ge=0, le=100)] = 20,
) -> MessageContextPublic:
    try:
        context = await get_message_context(
            session, current_user, chat_type, chat_id, message_id, before, after
        )
    except (LookupError, PermissionError) as exc:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Chat or message not found") from exc

    schema = {
        "group": MessagePublic,
        "direct": DirectMessagePublic,
        "discussion": DiscussionMessagePublic,
    }[chat_type]
    await annotate_message_context_with_pins(session, chat_type, chat_id, context.messages)
    return MessageContextPublic(
        chat_type=chat_type,
        chat_id=chat_id,
        target_message_id=message_id,
        messages=[
            schema.model_validate(message, context={"current_user_id": current_user.id})
            for message in context.messages
        ],
        has_more_before=context.has_more_before,
        has_more_after=context.has_more_after,
    )
