import logging
from datetime import date
from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Depends, Query, Request, status
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import get_current_user, get_db, require_can_manage_calendar
from app.models.user import User
from app.schemas.calendar import (
    CalendarAudiencePreview,
    CalendarCancelRequest,
    CalendarEventCreate,
    CalendarEventPage,
    CalendarEventPublic,
    CalendarEventUpdate,
    CalendarManageEventPage,
    CalendarPreviewRequest,
)
from app.services.calendar_events import (
    build_preview,
    cancel_event,
    create_event,
    get_visible_event,
    http_error_from_calendar_error,
    list_manage_events,
    list_visible_events,
    notify_recipients,
    restore_event,
    serialize_event,
    update_event,
    user_can_manage_event,
)

router = APIRouter()
logger = logging.getLogger("uvicorn.error")


@router.get("/events", response_model=CalendarEventPage)
async def get_calendar_events(
    session: Annotated[AsyncSession, Depends(get_db)],
    current_user: Annotated[User, Depends(get_current_user)],
    date_from: date,
    date_to: date,
    status_filter: Annotated[str | None, Query(alias="status")] = None,
    event_type: str | None = None,
    include_cancelled: bool = True,
    limit: Annotated[int, Query(ge=1, le=500)] = 200,
) -> CalendarEventPage:
    items, total = await list_visible_events(
        session,
        current_user,
        date_from=date_from,
        date_to=date_to,
        status_filter=status_filter,
        event_type=event_type,
        include_cancelled=include_cancelled,
        limit=limit,
    )
    return CalendarEventPage(
        items=[await serialize_event(session, item, current_user) for item in items],
        total=total,
        limit=limit,
    )


@router.get("/events/{event_id}", response_model=CalendarEventPublic)
async def get_calendar_event(
    event_id: UUID,
    session: Annotated[AsyncSession, Depends(get_db)],
    current_user: Annotated[User, Depends(get_current_user)],
) -> CalendarEventPublic:
    event = await get_visible_event(session, event_id, current_user)
    return await serialize_event(session, event, current_user)


@router.post("/events/preview-audience", response_model=CalendarAudiencePreview)
async def preview_calendar_audience(
    payload: CalendarPreviewRequest,
    session: Annotated[AsyncSession, Depends(get_db)],
    current_user: Annotated[User, Depends(require_can_manage_calendar)],
) -> CalendarAudiencePreview:
    try:
        return await build_preview(session, payload)
    except Exception as exc:
        raise http_error_from_calendar_error(exc) from exc


@router.post("/events", response_model=CalendarEventPublic, status_code=status.HTTP_201_CREATED)
async def post_calendar_event(
    payload: CalendarEventCreate,
    request: Request,
    session: Annotated[AsyncSession, Depends(get_db)],
    current_user: Annotated[User, Depends(require_can_manage_calendar)],
) -> CalendarEventPublic:
    try:
        event, recipient_ids = await create_event(session, current_user, payload, request=request)
        await session.refresh(event)
        response = await serialize_event(session, event, current_user)
        await session.commit()
    except Exception as exc:
        await session.rollback()
        logger.exception(
            "Calendar mutation failed operation=create request_id=%s error=%s",
            getattr(request.state, "request_id", None),
            type(exc).__name__,
        )
        raise http_error_from_calendar_error(exc) from exc
    try:
        await notify_recipients(session, response, recipient_ids, "calendar_created", "calendar.event_created", current_user)
    except Exception:
        logger.exception("Calendar event_created delivery failed event_id=%s", response.id)
    return response


@router.patch("/events/{event_id}", response_model=CalendarEventPublic)
async def patch_calendar_event(
    event_id: UUID,
    payload: CalendarEventUpdate,
    request: Request,
    session: Annotated[AsyncSession, Depends(get_db)],
    current_user: Annotated[User, Depends(require_can_manage_calendar)],
) -> CalendarEventPublic:
    event = await get_visible_event(session, event_id, current_user)
    try:
        updated, recipient_ids, rescheduled = await update_event(session, current_user, event, payload, request=request)
        await session.refresh(updated)
        response = await serialize_event(session, updated, current_user)
        await session.commit()
    except Exception as exc:
        await session.rollback()
        logger.exception(
            "Calendar mutation failed operation=update event_id=%s request_id=%s error=%s",
            event_id,
            getattr(request.state, "request_id", None),
            type(exc).__name__,
        )
        raise http_error_from_calendar_error(exc) from exc
    try:
        await notify_recipients(
            session,
            response,
            recipient_ids,
            "calendar_rescheduled" if rescheduled else "calendar_updated",
            "calendar.event_updated",
            current_user,
        )
    except Exception:
        logger.exception("Calendar event_updated delivery failed event_id=%s", response.id)
    return response


@router.post("/events/{event_id}/cancel", response_model=CalendarEventPublic)
async def post_calendar_event_cancel(
    event_id: UUID,
    payload: CalendarCancelRequest,
    request: Request,
    session: Annotated[AsyncSession, Depends(get_db)],
    current_user: Annotated[User, Depends(require_can_manage_calendar)],
) -> CalendarEventPublic:
    event = await get_visible_event(session, event_id, current_user)
    try:
        cancelled, recipient_ids = await cancel_event(session, current_user, event, payload.reason, request=request)
        await session.refresh(cancelled)
        response = await serialize_event(session, cancelled, current_user)
        await session.commit()
    except Exception as exc:
        await session.rollback()
        logger.exception(
            "Calendar mutation failed operation=cancel event_id=%s request_id=%s error=%s",
            event_id,
            getattr(request.state, "request_id", None),
            type(exc).__name__,
        )
        raise http_error_from_calendar_error(exc) from exc
    try:
        await notify_recipients(session, response, recipient_ids, "calendar_cancelled", "calendar.event_cancelled", current_user)
    except Exception:
        logger.exception("Calendar event_cancelled delivery failed event_id=%s", response.id)
    return response


@router.post("/events/{event_id}/restore", response_model=CalendarEventPublic)
async def post_calendar_event_restore(
    event_id: UUID,
    request: Request,
    session: Annotated[AsyncSession, Depends(get_db)],
    current_user: Annotated[User, Depends(require_can_manage_calendar)],
) -> CalendarEventPublic:
    event = await get_visible_event(session, event_id, current_user)
    try:
        restored, recipient_ids = await restore_event(session, current_user, event, request=request)
        await session.refresh(restored)
        response = await serialize_event(session, restored, current_user)
        await session.commit()
    except Exception as exc:
        await session.rollback()
        logger.exception(
            "Calendar mutation failed operation=restore event_id=%s request_id=%s error=%s",
            event_id,
            getattr(request.state, "request_id", None),
            type(exc).__name__,
        )
        raise http_error_from_calendar_error(exc) from exc
    try:
        await notify_recipients(session, response, recipient_ids, "calendar_updated", "calendar.event_updated", current_user)
    except Exception:
        logger.exception("Calendar event_restored delivery failed event_id=%s", response.id)
    return response


@router.get("/manage/events", response_model=CalendarManageEventPage)
async def get_calendar_manage_events(
    session: Annotated[AsyncSession, Depends(get_db)],
    current_user: Annotated[User, Depends(require_can_manage_calendar)],
    date_from: date | None = None,
    date_to: date | None = None,
    limit: Annotated[int, Query(ge=1, le=500)] = 100,
) -> CalendarManageEventPage:
    try:
        items, total = await list_manage_events(
            session,
            current_user,
            date_from=date_from,
            date_to=date_to,
            limit=limit,
        )
    except Exception as exc:
        raise http_error_from_calendar_error(exc) from exc
    return CalendarManageEventPage(
        items=[await serialize_event(session, item, current_user) for item in items],
        total=total,
        limit=limit,
    )
