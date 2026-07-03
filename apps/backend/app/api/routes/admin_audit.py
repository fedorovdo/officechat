import csv
import io
import json
from datetime import datetime
from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query, status
from fastapi.responses import Response
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import get_db, require_admin_user
from app.core.config import settings
from app.models.user import User
from app.schemas.audit import AuditEventPage, AuditEventPublic, AuditFilterOptions
from app.services.audit import (
    AuditEventQuery,
    export_audit_events,
    get_audit_event,
    get_audit_filter_options,
    list_audit_events,
    sanitize_audit_value,
)

router = APIRouter()


def build_query(
    page: Annotated[int, Query(ge=1)] = 1,
    limit: Annotated[int, Query(ge=1, le=200)] = 50,
    date_from: datetime | None = None,
    date_to: datetime | None = None,
    actor_user_id: UUID | None = None,
    actor_username: str | None = None,
    category: str | None = None,
    event_type: str | None = None,
    event_status: Annotated[str | None, Query(alias="status")] = None,
    target_type: str | None = None,
    target_id: str | None = None,
    search: str | None = None,
) -> AuditEventQuery:
    return AuditEventQuery(
        page=page,
        limit=limit,
        date_from=date_from,
        date_to=date_to,
        actor_user_id=actor_user_id,
        actor_username=actor_username,
        category=category,
        event_type=event_type,
        status=event_status,
        target_type=target_type,
        target_id=target_id,
        search=search,
    )


AuditQueryDependency = Annotated[AuditEventQuery, Depends(build_query)]


@router.get("/events", response_model=AuditEventPage)
async def get_events(
    query: AuditQueryDependency,
    session: Annotated[AsyncSession, Depends(get_db)],
    _: Annotated[User, Depends(require_admin_user)],
) -> AuditEventPage:
    rows, total = await list_audit_events(session, query)
    return AuditEventPage(items=[AuditEventPublic.model_validate(row) for row in rows], total=total, page=query.page, limit=query.limit)


@router.get("/filters", response_model=AuditFilterOptions)
async def get_filters(
    session: Annotated[AsyncSession, Depends(get_db)],
    _: Annotated[User, Depends(require_admin_user)],
) -> AuditFilterOptions:
    categories, statuses, event_types = await get_audit_filter_options(session)
    return AuditFilterOptions(categories=categories, statuses=statuses, event_types=event_types)


@router.get("/export.csv")
async def export_csv(
    query: AuditQueryDependency,
    session: Annotated[AsyncSession, Depends(get_db)],
    _: Annotated[User, Depends(require_admin_user)],
) -> Response:
    query.page = 1
    rows = await export_audit_events(session, query, settings.audit_max_export_rows)
    stream = io.StringIO()
    writer = csv.writer(stream)
    writer.writerow([
        "timestamp", "status", "category", "event_type", "actor", "actor_role", "target_type",
        "target_label", "source_ip", "request_id", "summary",
    ])
    for row in rows:
        summary = json.dumps(sanitize_audit_value(row.details or {}), ensure_ascii=False, separators=(",", ":"))[:2000]
        writer.writerow([
            row.created_at.isoformat(), row.status, row.category, row.event_type,
            row.actor_username or row.actor_display_name or "", row.actor_role or "",
            row.target_type or "", row.target_label or "", row.source_ip or "", row.request_id or "", summary,
        ])
    content = "\ufeff" + stream.getvalue()
    return Response(
        content=content.encode("utf-8"),
        media_type="text/csv; charset=utf-8",
        headers={"Content-Disposition": 'attachment; filename="officechat-audit.csv"'},
    )


@router.get("/events/{event_id}", response_model=AuditEventPublic)
async def get_event(
    event_id: UUID,
    session: Annotated[AsyncSession, Depends(get_db)],
    _: Annotated[User, Depends(require_admin_user)],
) -> AuditEventPublic:
    event = await get_audit_event(session, event_id)
    if event is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Audit event not found")
    return AuditEventPublic.model_validate(event)
