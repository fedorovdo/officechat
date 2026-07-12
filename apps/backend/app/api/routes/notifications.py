from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import get_current_user, get_db
from app.models.user import User
from app.schemas.notification import (
    NotificationPage,
    NotificationPreferencesPublic,
    NotificationPreferencesUpdate,
    NotificationReadAllRequest,
    NotificationUnreadCount,
    NotificationPublic,
)
from app.services.notifications import (
    dismiss_notification,
    get_or_create_preferences,
    list_notifications,
    mark_all_notifications_read,
    mark_notification_read,
    unread_count,
    update_preferences,
)

router = APIRouter()


@router.get("", response_model=NotificationPage)
async def get_notifications(
    session: Annotated[AsyncSession, Depends(get_db)],
    current_user: Annotated[User, Depends(get_current_user)],
    limit: Annotated[int, Query(ge=1, le=100)] = 30,
    cursor: str | None = None,
    category: str | None = None,
    type: str | None = None,
    unread_only: bool = False,
    include_dismissed: bool = False,
) -> NotificationPage:
    return await list_notifications(
        session,
        current_user.id,
        limit=limit,
        cursor=cursor,
        category=category,
        notification_type=type,
        unread_only=unread_only,
        include_dismissed=include_dismissed,
    )


@router.get("/unread-count", response_model=NotificationUnreadCount)
async def get_notifications_unread_count(
    session: Annotated[AsyncSession, Depends(get_db)],
    current_user: Annotated[User, Depends(get_current_user)],
) -> NotificationUnreadCount:
    return NotificationUnreadCount(unread_count=await unread_count(session, current_user.id))


@router.post("/{notification_id}/read", response_model=NotificationPublic)
async def post_notification_read(
    notification_id: UUID,
    session: Annotated[AsyncSession, Depends(get_db)],
    current_user: Annotated[User, Depends(get_current_user)],
) -> NotificationPublic:
    try:
        return NotificationPublic.model_validate(await mark_notification_read(session, current_user.id, notification_id))
    except LookupError as exc:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=str(exc)) from exc


@router.post("/read-all")
async def post_notifications_read_all(
    payload: NotificationReadAllRequest,
    session: Annotated[AsyncSession, Depends(get_db)],
    current_user: Annotated[User, Depends(get_current_user)],
) -> dict[str, int]:
    marked = await mark_all_notifications_read(session, current_user.id, payload.category)
    return {"marked_read": marked, "unread_count": await unread_count(session, current_user.id)}


@router.post("/{notification_id}/dismiss", response_model=NotificationPublic)
async def post_notification_dismiss(
    notification_id: UUID,
    session: Annotated[AsyncSession, Depends(get_db)],
    current_user: Annotated[User, Depends(get_current_user)],
) -> NotificationPublic:
    try:
        return NotificationPublic.model_validate(await dismiss_notification(session, current_user.id, notification_id))
    except LookupError as exc:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=str(exc)) from exc


@router.get("/preferences", response_model=NotificationPreferencesPublic)
async def get_notification_preferences(
    session: Annotated[AsyncSession, Depends(get_db)],
    current_user: Annotated[User, Depends(get_current_user)],
) -> NotificationPreferencesPublic:
    preferences = await get_or_create_preferences(session, current_user.id)
    await session.commit()
    return NotificationPreferencesPublic.model_validate(preferences)


@router.put("/preferences", response_model=NotificationPreferencesPublic)
async def put_notification_preferences(
    payload: NotificationPreferencesUpdate,
    session: Annotated[AsyncSession, Depends(get_db)],
    current_user: Annotated[User, Depends(get_current_user)],
) -> NotificationPreferencesPublic:
    return NotificationPreferencesPublic.model_validate(await update_preferences(session, current_user.id, payload))
