import logging
from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query, Request, Response, status
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import get_current_user, get_db, require_can_broadcast
from app.models.broadcast import BroadcastAnnouncement, BroadcastTemplate
from app.models.user import User
from app.schemas.broadcast import (
    AnnouncementPage,
    AnnouncementPublic,
    AnnouncementUnreadPublic,
    BroadcastCreate,
    BroadcastPage,
    BroadcastPreviewPublic,
    BroadcastPreviewRequest,
    BroadcastPublic,
    BroadcastSendRequest,
    BroadcastStatsPublic,
    BroadcastUpdate,
    BroadcastTemplateCreate,
    BroadcastTemplatePublic,
    BroadcastTemplatePage,
)
from app.services.audit import record_audit_event
from app.services.broadcasts import (
    announcement_event_payload_from_public,
    broadcast_created_events_from_payload,
    broadcast_retracted_events,
    build_preview,
    create_broadcast,
    ensure_sender,
    dismiss_announcement,
    get_sender_broadcast,
    http_error_from_broadcast_error,
    list_recipient_announcements,
    list_sent_broadcasts,
    load_broadcast_public,
    mark_announcement_read,
    retract_broadcast,
    send_broadcast,
    serialize_announcement,
    serialize_broadcast_public,
    stats_for_broadcast,
    unread_count,
    update_broadcast,
)
from app.services.websocket_manager import user_websocket_manager
from app.services.notifications import mark_source_notification_read

router = APIRouter()
logger = logging.getLogger("uvicorn.error")


def ensure_sender_scope(announcement: BroadcastAnnouncement, actor: User) -> None:
    if actor.role != "superadmin" and announcement.created_by_user_id != actor.id:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Broadcast not found")


async def get_scoped_broadcast(session: AsyncSession, broadcast_id: UUID, actor: User) -> BroadcastAnnouncement:
    announcement = await get_sender_broadcast(session, broadcast_id)
    if announcement is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Broadcast not found")
    ensure_sender_scope(announcement, actor)
    return announcement


async def broadcast_read_event(user_id: UUID, announcement_id: UUID, unread: int) -> None:
    await user_websocket_manager.broadcast_to_user(
        user_id,
        {
            "type": "announcement.read",
            "announcement_id": str(announcement_id),
            "unread_count": unread,
        },
    )


@router.post("/broadcasts/preview", response_model=BroadcastPreviewPublic)
async def preview_broadcast(
    payload: BroadcastPreviewRequest,
    request: Request,
    session: Annotated[AsyncSession, Depends(get_db)],
    current_user: Annotated[User, Depends(require_can_broadcast)],
) -> BroadcastPreviewPublic:
    try:
        preview = await build_preview(session, current_user, payload)
        await record_audit_event(
            session,
            event_type="broadcast.previewed",
            category="broadcasts",
            action="preview",
            status="success",
            actor=current_user,
            target_type="broadcast",
            details={
                "audience_type": payload.audience_type,
                "recipient_count": preview.recipient_count,
                "group_count": preview.group_count,
                "excluded_disabled": preview.excluded_disabled,
                "excluded_bots": preview.excluded_bots,
            },
            request=request,
        )
        await session.commit()
        return preview
    except Exception as exc:
        await session.rollback()
        raise http_error_from_broadcast_error(exc) from exc


@router.get("/broadcasts/sent", response_model=BroadcastPage)
async def get_sent_broadcasts(
    session: Annotated[AsyncSession, Depends(get_db)],
    current_user: Annotated[User, Depends(require_can_broadcast)],
    page: Annotated[int, Query(ge=1)] = 1,
    limit: Annotated[int, Query(ge=1, le=100)] = 20,
) -> BroadcastPage:
    items, total = await list_sent_broadcasts(session, current_user, page, limit)
    return BroadcastPage(items=[serialize_broadcast_public(item) for item in items], total=total, page=page, limit=limit)


@router.post("/broadcasts", response_model=BroadcastPublic, status_code=status.HTTP_201_CREATED)
async def post_broadcast(
    payload: BroadcastCreate,
    request: Request,
    session: Annotated[AsyncSession, Depends(get_db)],
    current_user: Annotated[User, Depends(require_can_broadcast)],
) -> BroadcastPublic:
    try:
        announcement = await create_broadcast(session, current_user, payload)
        await record_audit_event(
            session,
            event_type="broadcast.draft_created",
            category="broadcasts",
            action="create_draft",
            status="success",
            actor=current_user,
            target_type="broadcast",
            target_id=announcement.id,
            target_label=str(announcement.id),
            details={"priority": announcement.priority, "audience_type": announcement.audience_type},
            request=request,
        )
        response = await load_broadcast_public(session, announcement.id)
        await session.commit()
        return response
    except Exception as exc:
        await session.rollback()
        raise http_error_from_broadcast_error(exc) from exc


@router.get("/broadcasts/{broadcast_id}", response_model=BroadcastPublic)
async def get_broadcast(
    broadcast_id: UUID,
    session: Annotated[AsyncSession, Depends(get_db)],
    current_user: Annotated[User, Depends(require_can_broadcast)],
) -> BroadcastPublic:
    announcement = await get_scoped_broadcast(session, broadcast_id, current_user)
    return serialize_broadcast_public(announcement)


@router.patch("/broadcasts/{broadcast_id}", response_model=BroadcastPublic)
async def patch_broadcast(
    broadcast_id: UUID,
    payload: BroadcastUpdate,
    request: Request,
    session: Annotated[AsyncSession, Depends(get_db)],
    current_user: Annotated[User, Depends(require_can_broadcast)],
) -> BroadcastPublic:
    announcement = await get_scoped_broadcast(session, broadcast_id, current_user)
    try:
        updated = await update_broadcast(session, current_user, announcement, payload)
        await record_audit_event(
            session,
            event_type="broadcast.draft_updated",
            category="broadcasts",
            action="update_draft",
            status="success",
            actor=current_user,
            target_type="broadcast",
            target_id=updated.id,
            target_label=str(updated.id),
            details={"priority": updated.priority, "audience_type": updated.audience_type},
            request=request,
        )
        response = await load_broadcast_public(session, updated.id)
        await session.commit()
        return response
    except Exception as exc:
        await session.rollback()
        raise http_error_from_broadcast_error(exc) from exc


@router.post("/broadcasts/{broadcast_id}/send", response_model=BroadcastPublic)
async def post_broadcast_send(
    broadcast_id: UUID,
    payload: BroadcastSendRequest,
    request: Request,
    session: Annotated[AsyncSession, Depends(get_db)],
    current_user: Annotated[User, Depends(require_can_broadcast)],
) -> BroadcastPublic:
    announcement = await get_scoped_broadcast(session, broadcast_id, current_user)
    try:
        sent, recipient_ids = await send_broadcast(session, current_user, announcement, payload, request=request)
        response = await load_broadcast_public(session, sent.id)
        event_payload = announcement_event_payload_from_public(response)
        await session.commit()
    except Exception as exc:
        await session.rollback()
        raise http_error_from_broadcast_error(exc) from exc
    if recipient_ids:
        try:
            await broadcast_created_events_from_payload(session, event_payload, recipient_ids)
        except Exception:
            logger.exception("Broadcast announcement.created delivery failed broadcast_id=%s", response.id)
    return response


@router.post("/broadcasts/{broadcast_id}/retract", response_model=BroadcastPublic)
async def post_broadcast_retract(
    broadcast_id: UUID,
    request: Request,
    session: Annotated[AsyncSession, Depends(get_db)],
    current_user: Annotated[User, Depends(require_can_broadcast)],
) -> BroadcastPublic:
    announcement = await get_scoped_broadcast(session, broadcast_id, current_user)
    try:
        recipient_ids = await retract_broadcast(session, current_user, announcement, request=request)
        response = await load_broadcast_public(session, announcement.id)
        await session.commit()
    except Exception as exc:
        await session.rollback()
        raise http_error_from_broadcast_error(exc) from exc
    try:
        await broadcast_retracted_events(session, response.id, recipient_ids)
    except Exception:
        logger.exception("Broadcast announcement.retracted delivery failed broadcast_id=%s", response.id)
    return response


@router.get("/broadcasts/{broadcast_id}/stats", response_model=BroadcastStatsPublic)
async def get_broadcast_stats(
    broadcast_id: UUID,
    session: Annotated[AsyncSession, Depends(get_db)],
    current_user: Annotated[User, Depends(require_can_broadcast)],
) -> BroadcastStatsPublic:
    announcement = await get_scoped_broadcast(session, broadcast_id, current_user)
    return BroadcastStatsPublic(**await stats_for_broadcast(session, announcement))


@router.get("/announcements", response_model=AnnouncementPage)
async def get_announcements(
    session: Annotated[AsyncSession, Depends(get_db)],
    current_user: Annotated[User, Depends(get_current_user)],
    page: Annotated[int, Query(ge=1)] = 1,
    limit: Annotated[int, Query(ge=1, le=100)] = 20,
) -> AnnouncementPage:
    rows, total = await list_recipient_announcements(session, current_user, page, limit)
    return AnnouncementPage(items=[serialize_announcement(row) for row in rows], total=total, page=page, limit=limit)


@router.get("/announcements/unread", response_model=AnnouncementUnreadPublic)
async def get_announcements_unread(
    session: Annotated[AsyncSession, Depends(get_db)],
    current_user: Annotated[User, Depends(get_current_user)],
) -> AnnouncementUnreadPublic:
    return AnnouncementUnreadPublic(unread_count=await unread_count(session, current_user.id))


@router.get("/announcements/{announcement_id}", response_model=AnnouncementPublic)
async def get_announcement(
    announcement_id: UUID,
    session: Annotated[AsyncSession, Depends(get_db)],
    current_user: Annotated[User, Depends(get_current_user)],
) -> AnnouncementPublic:
    try:
        announcement, count = await mark_announcement_read(session, current_user, announcement_id)
        await session.commit()
        await broadcast_read_event(current_user.id, announcement_id, count)
        await mark_source_notification_read(session, current_user.id, "announcement", announcement_id)
        return announcement
    except Exception as exc:
        await session.rollback()
        raise http_error_from_broadcast_error(exc) from exc


@router.post("/announcements/{announcement_id}/read", response_model=AnnouncementPublic)
async def post_announcement_read(
    announcement_id: UUID,
    session: Annotated[AsyncSession, Depends(get_db)],
    current_user: Annotated[User, Depends(get_current_user)],
) -> AnnouncementPublic:
    try:
        announcement, count = await mark_announcement_read(session, current_user, announcement_id)
        await session.commit()
        await broadcast_read_event(current_user.id, announcement_id, count)
        await mark_source_notification_read(session, current_user.id, "announcement", announcement_id)
        return announcement
    except Exception as exc:
        await session.rollback()
        raise http_error_from_broadcast_error(exc) from exc


@router.post("/announcements/{announcement_id}/dismiss", response_model=AnnouncementPublic)
async def post_announcement_dismiss(
    announcement_id: UUID,
    session: Annotated[AsyncSession, Depends(get_db)],
    current_user: Annotated[User, Depends(get_current_user)],
) -> AnnouncementPublic:
    try:
        announcement, _ = await dismiss_announcement(session, current_user, announcement_id)
        await session.commit()
        return announcement
    except Exception as exc:
        await session.rollback()
        raise http_error_from_broadcast_error(exc) from exc


async def require_template_sender(
    current_user: Annotated[User, Depends(require_can_broadcast)],
) -> User:
    try:
        ensure_sender(current_user)
    except PermissionError as exc:
        raise HTTPException(status_code=403, detail="Permission required") from exc
    return current_user


@router.get("/broadcast-templates", response_model=BroadcastTemplatePage)
async def get_broadcast_templates(
    session: Annotated[AsyncSession, Depends(get_db)],
    current_user: Annotated[User, Depends(require_template_sender)],
    page: Annotated[int, Query(ge=1)] = 1,
    limit: Annotated[int, Query(ge=1, le=100)] = 20,
) -> BroadcastTemplatePage:
    total = int(await session.scalar(select(func.count()).select_from(BroadcastTemplate)) or 0)
    result = await session.scalars(select(BroadcastTemplate)
        .order_by(BroadcastTemplate.name, BroadcastTemplate.id)
        .offset((page - 1) * limit).limit(limit))
    return BroadcastTemplatePage(items=[BroadcastTemplatePublic.model_validate(item)
        for item in result.all()], total=total, page=page, limit=limit)


async def owned_template(session: AsyncSession, template_id: UUID, actor: User) -> BroadcastTemplate:
    template = await session.get(BroadcastTemplate, template_id, with_for_update=True)
    if template is None:
        raise HTTPException(status_code=404, detail="Template not found")
    # Author-only, including for superadmin; possession of can_broadcast is insufficient.
    if template.created_by_user_id != actor.id:
        raise HTTPException(status_code=403, detail="Only the template author can change it")
    return template


async def audit_template(session, request, actor, template, action):
    await record_audit_event(session, event_type=f"broadcast.template_{action}",
        category="broadcasts", action=action, status="success", actor=actor,
        target_type="broadcast_template", target_id=template.id,
        target_label=str(template.id), request=request)


@router.post("/broadcast-templates", response_model=BroadcastTemplatePublic, status_code=201)
async def post_broadcast_template(
    payload: BroadcastTemplateCreate,
    request: Request,
    session: Annotated[AsyncSession, Depends(get_db)],
    current_user: Annotated[User, Depends(require_template_sender)],
) -> BroadcastTemplatePublic:
    template = BroadcastTemplate(created_by_user_id=current_user.id,
        created_by_display_name=current_user.display_name, **payload.model_dump())
    session.add(template)
    await session.flush()
    await session.refresh(template)
    await audit_template(session, request, current_user, template, "created")
    response = BroadcastTemplatePublic.model_validate(template)
    await session.commit()
    return response


@router.put("/broadcast-templates/{template_id}", response_model=BroadcastTemplatePublic)
async def put_broadcast_template(
    template_id: UUID,
    payload: BroadcastTemplateCreate,
    request: Request,
    session: Annotated[AsyncSession, Depends(get_db)],
    current_user: Annotated[User, Depends(require_template_sender)],
) -> BroadcastTemplatePublic:
    template = await owned_template(session, template_id, current_user)
    for key, value in payload.model_dump().items():
        setattr(template, key, value)
    await session.flush()
    await session.refresh(template)
    await audit_template(session, request, current_user, template, "updated")
    response = BroadcastTemplatePublic.model_validate(template)
    await session.commit()
    return response


@router.delete("/broadcast-templates/{template_id}", status_code=204)
async def delete_broadcast_template(
    template_id: UUID,
    request: Request,
    session: Annotated[AsyncSession, Depends(get_db)],
    current_user: Annotated[User, Depends(require_template_sender)],
) -> Response:
    template = await owned_template(session, template_id, current_user)
    await audit_template(session, request, current_user, template, "deleted")
    await session.delete(template)
    await session.commit()
    return Response(status_code=204)
