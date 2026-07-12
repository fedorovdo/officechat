import uuid
from dataclasses import dataclass
from datetime import date, datetime, time, timedelta, timezone
from typing import Any
from urllib.parse import urlparse
from uuid import UUID
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from fastapi import HTTPException, status
from sqlalchemy import func, or_, select, update
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.core.config import settings
from app.core.permissions import CAN_MANAGE_CALENDAR
from app.models.calendar import CalendarEvent, CalendarEventRecipient, CalendarReminderDelivery
from app.models.group import Group, GroupMember
from app.models.user import User
from app.schemas.calendar import (
    CalendarAudiencePayload,
    CalendarAudiencePreview,
    CalendarEventCreate,
    CalendarEventPublic,
    CalendarEventUpdate,
    CalendarOrganizerPublic,
    CalendarAudienceSummary,
)
from app.services.audit import record_audit_event
from app.services.notifications import safe_create_notification, sanitize_preview
from app.services.permissions import has_permission
from app.services.websocket_manager import user_websocket_manager

ALLOWED_REMINDERS = {0, 15, 30, 60, 1440}


class CalendarError(ValueError):
    pass


class CalendarConflictError(CalendarError):
    pass


@dataclass(slots=True)
class AudienceResolution:
    users: list[User]
    sources: dict[UUID, tuple[str, UUID | None]]
    group_count: int = 0
    excluded_disabled: int = 0
    excluded_bots: int = 0
    duplicates_removed: int = 0


def now_utc() -> datetime:
    return datetime.now(timezone.utc)


def ensure_aware_utc(value: datetime, field_name: str) -> datetime:
    if value.tzinfo is None or value.tzinfo.utcoffset(value) is None:
        raise CalendarError(f"{field_name} must include timezone information")
    return value.astimezone(timezone.utc)


def validate_timezone(value: str | None) -> str:
    timezone_name = (value or settings.calendar_default_timezone).strip()
    try:
        ZoneInfo(timezone_name)
    except ZoneInfoNotFoundError as exc:
        raise CalendarError("Invalid timezone") from exc
    return timezone_name


def validate_conference_url(value: str | None) -> str | None:
    if value is None:
        return None
    parsed = urlparse(value)
    if parsed.scheme not in {"http", "https"} or not parsed.netloc:
        raise CalendarError("Conference URL must be http(s)")
    return value


def normalize_reminders(values: list[int] | None) -> list[int]:
    reminders = sorted({int(value) for value in (values or [])}, reverse=True)
    if len(reminders) > settings.calendar_max_reminders:
        raise CalendarError("Too many reminders")
    invalid = [value for value in reminders if value not in ALLOWED_REMINDERS]
    if invalid:
        raise CalendarError("Unsupported reminder value")
    return reminders


def normalize_audience(payload: CalendarAudiencePayload) -> dict[str, object]:
    group_ids = sorted({str(group_id) for group_id in payload.group_ids})
    user_ids = sorted({str(user_id) for user_id in payload.user_ids})
    if payload.audience_type == "all_active_users":
        return {"group_ids": [], "user_ids": []}
    if payload.audience_type == "selected_groups":
        if not group_ids:
            raise CalendarError("At least one group is required")
        return {"group_ids": group_ids, "user_ids": []}
    if not user_ids:
        raise CalendarError("At least one user is required")
    return {"group_ids": [], "user_ids": user_ids}


def human_user_filter() -> tuple:
    return (
        User.is_active.is_(True),
        User.role != "bot",
        User.auth_provider != "bot",
        User.is_system.is_(False),
    )


async def resolve_audience(
    session: AsyncSession,
    audience_type: str,
    audience_definition: dict[str, object] | None,
) -> AudienceResolution:
    audience_definition = audience_definition or {}
    if audience_type == "all_active_users":
        rows = await session.execute(select(User).where(*human_user_filter()).order_by(User.username.asc()))
        users = list(rows.scalars().all())
        return AudienceResolution(users=users, sources={user.id: ("all_users", None) for user in users})

    if audience_type == "selected_groups":
        group_ids = [UUID(str(value)) for value in audience_definition.get("group_ids", [])]
        rows = await session.execute(
            select(User, GroupMember.group_id)
            .join(GroupMember, GroupMember.user_id == User.id)
            .join(Group, Group.id == GroupMember.group_id)
            .where(Group.id.in_(group_ids), Group.is_active.is_(True))
            .order_by(User.username.asc())
        )
        unique: dict[UUID, User] = {}
        sources: dict[UUID, tuple[str, UUID | None]] = {}
        excluded_disabled = 0
        excluded_bots = 0
        raw_count = 0
        for user, group_id in rows.all():
            raw_count += 1
            if not user.is_active or user.is_system:
                excluded_disabled += 1
                continue
            if user.role == "bot" or user.auth_provider == "bot":
                excluded_bots += 1
                continue
            unique[user.id] = user
            sources.setdefault(user.id, ("group", group_id))
        return AudienceResolution(
            users=sorted(unique.values(), key=lambda item: item.username),
            sources=sources,
            group_count=len(group_ids),
            excluded_disabled=excluded_disabled,
            excluded_bots=excluded_bots,
            duplicates_removed=max(0, raw_count - len(unique) - excluded_disabled - excluded_bots),
        )

    user_ids = [UUID(str(value)) for value in audience_definition.get("user_ids", [])]
    rows = await session.execute(select(User).where(User.id.in_(user_ids)).order_by(User.username.asc()))
    users = list(rows.scalars().all())
    by_id = {user.id: user for user in users}
    missing = [user_id for user_id in user_ids if user_id not in by_id]
    if missing:
        raise CalendarError("Selected user not found")
    invalid = [user for user in users if not user.is_active or user.is_system or user.role == "bot" or user.auth_provider == "bot"]
    if invalid:
        raise CalendarError("Selected users must be active human users")
    return AudienceResolution(users=users, sources={user.id: ("individual", user.id) for user in users})


async def build_preview(session: AsyncSession, payload: CalendarAudiencePayload) -> CalendarAudiencePreview:
    audience_definition = normalize_audience(payload)
    resolved = await resolve_audience(session, payload.audience_type, audience_definition)
    if not resolved.users:
        raise CalendarError("Audience has no recipients")
    if len(resolved.users) > settings.calendar_max_recipients:
        raise CalendarError("Too many recipients")
    return CalendarAudiencePreview(
        recipient_count=len(resolved.users),
        group_count=resolved.group_count,
        excluded_disabled=resolved.excluded_disabled,
        excluded_bots=resolved.excluded_bots,
        duplicates_removed=resolved.duplicates_removed,
    )


def normalize_event_time(payload: CalendarEventCreate | CalendarEventUpdate, existing: CalendarEvent | None = None) -> dict[str, Any]:
    is_all_day = payload.is_all_day if payload.is_all_day is not None else (existing.is_all_day if existing else False)
    timezone_name = validate_timezone(payload.timezone if payload.timezone is not None else (existing.timezone if existing else None))
    if is_all_day:
        start_date = payload.all_day_start_date if payload.all_day_start_date is not None else (existing.all_day_start_date if existing else None)
        end_date = payload.all_day_end_date if payload.all_day_end_date is not None else (existing.all_day_end_date if existing else None)
        if start_date is None or end_date is None:
            raise CalendarError("All-day events require start and end dates")
        if end_date < start_date:
            raise CalendarError("End date cannot be before start date")
        return {
            "is_all_day": True,
            "starts_at": None,
            "ends_at": None,
            "all_day_start_date": start_date,
            "all_day_end_date": end_date,
            "timezone": timezone_name,
        }

    starts_at = payload.starts_at if payload.starts_at is not None else (existing.starts_at if existing else None)
    ends_at = payload.ends_at if payload.ends_at is not None else (existing.ends_at if existing else None)
    if starts_at is None or ends_at is None:
        raise CalendarError("Timed events require start and end")
    starts_at_utc = ensure_aware_utc(starts_at, "starts_at")
    ends_at_utc = ensure_aware_utc(ends_at, "ends_at")
    if ends_at_utc <= starts_at_utc:
        raise CalendarError("End time must be after start time")
    if ends_at_utc - starts_at_utc > timedelta(days=settings.calendar_max_duration_days):
        raise CalendarError("Event duration is too long")
    return {
        "is_all_day": False,
        "starts_at": starts_at_utc,
        "ends_at": ends_at_utc,
        "all_day_start_date": None,
        "all_day_end_date": None,
        "timezone": timezone_name,
    }


def reminder_base_time(event: CalendarEvent) -> datetime:
    if event.is_all_day:
        assert event.all_day_start_date is not None
        local_start = datetime.combine(event.all_day_start_date, time.min, tzinfo=ZoneInfo(event.timezone))
        return local_start.astimezone(timezone.utc)
    assert event.starts_at is not None
    return event.starts_at.astimezone(timezone.utc)


async def reconcile_recipients_and_reminders(
    session: AsyncSession,
    event: CalendarEvent,
    resolved: AudienceResolution,
) -> list[UUID]:
    requested_users = {user.id: user for user in resolved.users}
    rows = await session.execute(select(CalendarEventRecipient).where(CalendarEventRecipient.event_id == event.id))
    existing_recipients = {recipient.user_id: recipient for recipient in rows.scalars().all() if recipient.user_id is not None}

    obsolete_user_ids = set(existing_recipients) - set(requested_users)
    for user_id in obsolete_user_ids:
        await session.delete(existing_recipients[user_id])

    for user in resolved.users:
        source_type, source_id = resolved.sources.get(user.id, ("individual", user.id))
        existing = existing_recipients.get(user.id)
        if existing is None:
            session.add(
                CalendarEventRecipient(
                    id=uuid.uuid4(),
                    event_id=event.id,
                    user_id=user.id,
                    username_snapshot=user.username,
                    display_name_snapshot=user.display_name,
                    source_type=source_type,
                    source_id=source_id,
                )
            )
        else:
            existing.username_snapshot = user.username
            existing.display_name_snapshot = user.display_name
            existing.source_type = source_type
            existing.source_id = source_id

    base = reminder_base_time(event)
    current_time = now_utc()
    desired_future: set[tuple[UUID, int, datetime]] = set()
    if event.status != "cancelled":
        for user in resolved.users:
            for minutes in event.reminder_minutes or []:
                scheduled_for = base - timedelta(minutes=minutes)
                if scheduled_for > current_time:
                    desired_future.add((user.id, minutes, scheduled_for))

    reminder_rows = await session.execute(
        select(CalendarReminderDelivery).where(
            CalendarReminderDelivery.event_id == event.id,
            CalendarReminderDelivery.status == "pending",
        )
    )
    existing_pending = list(reminder_rows.scalars().all())
    existing_future_keys = {
        (delivery.user_id, delivery.reminder_minutes, delivery.scheduled_for): delivery
        for delivery in existing_pending
        if delivery.scheduled_for > current_time
    }

    for key, delivery in existing_future_keys.items():
        if key not in desired_future:
            delivery.status = "skipped"

    for user_id, minutes, scheduled_for in desired_future - set(existing_future_keys):
        session.add(
            CalendarReminderDelivery(
                id=uuid.uuid4(),
                event_id=event.id,
                user_id=user_id,
                reminder_minutes=minutes,
                scheduled_for=scheduled_for,
            )
        )
    await session.flush()
    return [user.id for user in resolved.users]


async def user_can_view_event(session: AsyncSession, event: CalendarEvent, user: User) -> bool:
    if user.role == "superadmin":
        return True
    if event.created_by_user_id == user.id:
        return True
    return bool(
        await session.scalar(
            select(CalendarEventRecipient.id).where(
                CalendarEventRecipient.event_id == event.id,
                CalendarEventRecipient.user_id == user.id,
            )
        )
    )


async def user_can_manage_event(session: AsyncSession, event: CalendarEvent, user: User) -> bool:
    if not user.is_active or user.role == "bot":
        return False
    if user.role == "superadmin":
        return True
    if not await has_permission(session, user, CAN_MANAGE_CALENDAR):
        return False
    if event.created_by_user_id == user.id:
        return True
    if event.audience_type in {"all_active_users", "selected_groups"} and await user_can_view_event(session, event, user):
        return True
    return False


async def serialize_event(session: AsyncSession, event: CalendarEvent, user: User) -> CalendarEventPublic:
    recipient_count = int(
        await session.scalar(select(func.count(CalendarEventRecipient.id)).where(CalendarEventRecipient.event_id == event.id))
        or 0
    )
    can_manage = await user_can_manage_event(session, event, user)
    editable_audience = None
    if can_manage:
        audience_definition = event.audience_definition or {}
        editable_audience = CalendarAudiencePayload(
            audience_type=event.audience_type,
            group_ids=[UUID(str(value)) for value in audience_definition.get("group_ids", [])],
            user_ids=[UUID(str(value)) for value in audience_definition.get("user_ids", [])],
        )
    return CalendarEventPublic(
        id=event.id,
        title=event.title,
        description=event.description,
        event_type=event.event_type,
        status=event.status,
        is_all_day=event.is_all_day,
        starts_at=event.starts_at,
        ends_at=event.ends_at,
        all_day_start_date=event.all_day_start_date,
        all_day_end_date=event.all_day_end_date,
        timezone=event.timezone,
        location=event.location,
        conference_url=None if event.status == "cancelled" else event.conference_url,
        created_by=CalendarOrganizerPublic(
            id=event.created_by_user_id,
            username=event.created_by_username,
            display_name=event.created_by_display_name,
        ),
        audience_summary=CalendarAudienceSummary(type=event.audience_type, recipient_count=recipient_count),
        editable_audience=editable_audience,
        reminder_minutes=list(event.reminder_minutes or []),
        can_manage=can_manage,
        cancelled_at=event.cancelled_at,
        cancellation_reason=event.cancellation_reason,
        created_at=event.created_at,
        updated_at=event.updated_at,
    )


def safe_event_payload(public: CalendarEventPublic) -> dict[str, object]:
    return public.model_dump(mode="json")


async def notify_recipients(
    session: AsyncSession,
    event: CalendarEventPublic,
    recipient_ids: list[UUID],
    notification_type: str,
    ws_type: str,
    actor: User | None = None,
) -> None:
    public_payload = event.model_copy(update={"can_manage": False, "editable_audience": None})
    for user_id in recipient_ids:
        await safe_create_notification(
            session,
            recipient_user_id=user_id,
            notification_type=notification_type,
            category="calendar",
            actor=actor,
            actor_username=event.created_by.username,
            actor_display_name=event.created_by.display_name,
            source_type="calendar_event",
            source_id=event.id,
            title_key=f"notification.{notification_type}",
            body_preview=event.title,
            metadata={
                "calendar_event_id": event.id,
                "calendar_status": event.status,
                "calendar_event_type": event.event_type,
            },
        )
        await user_websocket_manager.broadcast_to_user(
            user_id,
            {
                "type": ws_type,
                "event": safe_event_payload(public_payload),
            },
        )


async def create_event(session: AsyncSession, actor: User, payload: CalendarEventCreate, request=None) -> tuple[CalendarEvent, list[UUID]]:
    time_fields = normalize_event_time(payload)
    reminders = normalize_reminders(payload.reminder_minutes)
    conference_url = validate_conference_url(payload.conference_url)
    audience_definition = normalize_audience(payload)
    resolved = await resolve_audience(session, payload.audience_type, audience_definition)
    if not resolved.users:
        raise CalendarError("Audience has no recipients")
    if len(resolved.users) > settings.calendar_max_recipients:
        raise CalendarError("Too many recipients")
    event = CalendarEvent(
        id=uuid.uuid4(),
        title=payload.title[: settings.calendar_title_max_length],
        description=payload.description,
        event_type=payload.event_type,
        status="scheduled",
        location=payload.location,
        conference_url=conference_url,
        audience_type=payload.audience_type,
        audience_definition=audience_definition,
        created_by_user_id=actor.id,
        created_by_username=actor.username,
        created_by_display_name=actor.display_name,
        reminder_minutes=reminders,
        **time_fields,
    )
    session.add(event)
    await session.flush()
    recipient_ids = await reconcile_recipients_and_reminders(session, event, resolved)
    await record_audit_event(
        session,
        event_type="calendar.event_created",
        category="calendar",
        action="create",
        status="success",
        actor=actor,
        target_type="calendar_event",
        target_id=event.id,
        target_label=str(event.id),
        details=audit_details(event, len(recipient_ids), resolved.group_count),
        request=request,
    )
    return event, recipient_ids


def update_payload_has_audience(payload: CalendarEventUpdate) -> bool:
    return payload.audience_type is not None or payload.group_ids is not None or payload.user_ids is not None


async def update_event(session: AsyncSession, actor: User, event: CalendarEvent, payload: CalendarEventUpdate, request=None) -> tuple[CalendarEvent, list[UUID], bool]:
    if not await user_can_manage_event(session, event, actor):
        raise PermissionError("Permission required")
    old_starts_at = event.starts_at
    old_ends_at = event.ends_at
    time_fields = normalize_event_time(payload, event)
    for key, value in time_fields.items():
        setattr(event, key, value)
    if payload.title is not None:
        event.title = payload.title[: settings.calendar_title_max_length]
    if payload.description is not None:
        event.description = payload.description
    if payload.event_type is not None:
        event.event_type = payload.event_type
    if payload.location is not None:
        event.location = payload.location
    if payload.conference_url is not None:
        event.conference_url = validate_conference_url(payload.conference_url)
    if payload.reminder_minutes is not None:
        event.reminder_minutes = normalize_reminders(payload.reminder_minutes)

    audience_type = payload.audience_type or event.audience_type
    audience_definition = event.audience_definition or {}
    if update_payload_has_audience(payload):
        audience_definition = normalize_audience(
            CalendarAudiencePayload(
                audience_type=audience_type,
                group_ids=payload.group_ids or [],
                user_ids=payload.user_ids or [],
            )
        )
        event.audience_type = audience_type
        event.audience_definition = audience_definition
    resolved = await resolve_audience(session, event.audience_type, audience_definition)
    if not resolved.users:
        raise CalendarError("Audience has no recipients")
    if len(resolved.users) > settings.calendar_max_recipients:
        raise CalendarError("Too many recipients")

    rescheduled = old_starts_at != event.starts_at or old_ends_at != event.ends_at
    if rescheduled and event.status != "cancelled":
        event.status = "rescheduled"
    recipient_ids = await reconcile_recipients_and_reminders(session, event, resolved)
    await record_audit_event(
        session,
        event_type="calendar.event_rescheduled" if rescheduled else "calendar.event_updated",
        category="calendar",
        action="reschedule" if rescheduled else "update",
        status="success",
        actor=actor,
        target_type="calendar_event",
        target_id=event.id,
        target_label=str(event.id),
        details={
            **audit_details(event, len(recipient_ids), resolved.group_count),
            "old_starts_at": old_starts_at,
            "old_ends_at": old_ends_at,
            "new_starts_at": event.starts_at,
            "new_ends_at": event.ends_at,
        },
        request=request,
    )
    await session.flush()
    return event, recipient_ids, rescheduled


async def cancel_event(session: AsyncSession, actor: User, event: CalendarEvent, reason: str | None, request=None) -> tuple[CalendarEvent, list[UUID]]:
    if not await user_can_manage_event(session, event, actor):
        raise PermissionError("Permission required")
    event.status = "cancelled"
    event.cancelled_by_user_id = actor.id
    event.cancelled_at = now_utc()
    event.cancellation_reason = reason
    rows = await session.execute(select(CalendarEventRecipient.user_id).where(CalendarEventRecipient.event_id == event.id))
    recipient_ids = [user_id for user_id in rows.scalars().all() if user_id is not None]
    await session.execute(
        update(CalendarReminderDelivery)
        .where(
            CalendarReminderDelivery.event_id == event.id,
            CalendarReminderDelivery.status == "pending",
            CalendarReminderDelivery.scheduled_for > now_utc(),
        )
        .values(status="skipped")
    )
    await record_audit_event(
        session,
        event_type="calendar.event_cancelled",
        category="calendar",
        action="cancel",
        status="success",
        actor=actor,
        target_type="calendar_event",
        target_id=event.id,
        target_label=str(event.id),
        details=audit_details(event, len(recipient_ids), 0),
        request=request,
    )
    await session.flush()
    return event, recipient_ids


async def restore_event(session: AsyncSession, actor: User, event: CalendarEvent, request=None) -> tuple[CalendarEvent, list[UUID]]:
    if not await user_can_manage_event(session, event, actor):
        raise PermissionError("Permission required")
    event.status = "scheduled"
    event.cancelled_by_user_id = None
    event.cancelled_at = None
    event.cancellation_reason = None
    resolved = await resolve_audience(session, event.audience_type, event.audience_definition)
    recipient_ids = await reconcile_recipients_and_reminders(session, event, resolved)
    await record_audit_event(
        session,
        event_type="calendar.event_restored",
        category="calendar",
        action="restore",
        status="success",
        actor=actor,
        target_type="calendar_event",
        target_id=event.id,
        target_label=str(event.id),
        details=audit_details(event, len(recipient_ids), resolved.group_count),
        request=request,
    )
    await session.flush()
    return event, recipient_ids


def audit_details(event: CalendarEvent, recipient_count: int, group_count: int) -> dict[str, object]:
    return {
        "event_type": event.event_type,
        "audience_type": event.audience_type,
        "recipient_count": recipient_count,
        "group_count": group_count,
        "is_all_day": event.is_all_day,
        "starts_at": event.starts_at,
        "ends_at": event.ends_at,
        "all_day_start_date": event.all_day_start_date,
        "all_day_end_date": event.all_day_end_date,
        "status": event.status,
    }


def event_date_conditions(date_from: date, date_to: date) -> list[Any]:
    start_dt = datetime.combine(date_from, time.min, tzinfo=timezone.utc)
    end_dt = datetime.combine(date_to + timedelta(days=1), time.min, tzinfo=timezone.utc)
    return [
        or_(
            (CalendarEvent.is_all_day.is_(False) & (CalendarEvent.starts_at < end_dt) & (CalendarEvent.ends_at > start_dt)),
            (
                CalendarEvent.is_all_day.is_(True)
                & (CalendarEvent.all_day_start_date <= date_to)
                & (CalendarEvent.all_day_end_date >= date_from)
            ),
        )
    ]


async def list_visible_events(
    session: AsyncSession,
    user: User,
    *,
    date_from: date,
    date_to: date,
    status_filter: str | None,
    event_type: str | None,
    include_cancelled: bool,
    limit: int,
) -> tuple[list[CalendarEvent], int]:
    conditions = event_date_conditions(date_from, date_to)
    if status_filter:
        conditions.append(CalendarEvent.status == status_filter)
    elif not include_cancelled:
        conditions.append(CalendarEvent.status != "cancelled")
    if event_type:
        conditions.append(CalendarEvent.event_type == event_type)
    if user.role != "superadmin":
        conditions.append(
            or_(
                CalendarEvent.created_by_user_id == user.id,
                CalendarEvent.id.in_(select(CalendarEventRecipient.event_id).where(CalendarEventRecipient.user_id == user.id)),
            )
        )
    total = int(await session.scalar(select(func.count(CalendarEvent.id)).where(*conditions)) or 0)
    rows = await session.execute(
        select(CalendarEvent)
        .where(*conditions)
        .order_by(CalendarEvent.is_all_day.desc(), CalendarEvent.starts_at.asc().nullslast(), CalendarEvent.all_day_start_date.asc().nullslast())
        .limit(limit)
    )
    return list(rows.scalars().all()), total


async def list_manage_events(
    session: AsyncSession,
    user: User,
    *,
    date_from: date | None = None,
    date_to: date | None = None,
    limit: int = 100,
) -> tuple[list[CalendarEvent], int]:
    if user.role != "superadmin" and not await has_permission(session, user, CAN_MANAGE_CALENDAR):
        raise PermissionError("Permission required")
    conditions: list[Any] = []
    if date_from and date_to:
        conditions.extend(event_date_conditions(date_from, date_to))
    if user.role != "superadmin":
        conditions.append(
            or_(
                CalendarEvent.created_by_user_id == user.id,
                (
                    CalendarEvent.audience_type.in_(("all_active_users", "selected_groups"))
                    & CalendarEvent.id.in_(select(CalendarEventRecipient.event_id).where(CalendarEventRecipient.user_id == user.id))
                ),
            )
        )
    total = int(await session.scalar(select(func.count(CalendarEvent.id)).where(*conditions)) or 0)
    rows = await session.execute(select(CalendarEvent).where(*conditions).order_by(CalendarEvent.created_at.desc()).limit(limit))
    return list(rows.scalars().all()), total


async def get_visible_event(session: AsyncSession, event_id: UUID, user: User) -> CalendarEvent:
    event = await session.get(CalendarEvent, event_id)
    if event is None or not await user_can_view_event(session, event, user):
        raise LookupError("Calendar event not found")
    return event


async def deliver_due_reminders(session: AsyncSession, *, limit: int | None = None) -> int:
    limit = limit or settings.calendar_reminder_batch_size
    rows = await session.execute(
        select(CalendarReminderDelivery)
        .options(selectinload(CalendarReminderDelivery.event), selectinload(CalendarReminderDelivery.user))
        .where(CalendarReminderDelivery.status == "pending", CalendarReminderDelivery.scheduled_for <= now_utc())
        .order_by(CalendarReminderDelivery.scheduled_for.asc())
        .limit(limit)
        .with_for_update(skip_locked=True)
    )
    deliveries = list(rows.scalars().all())
    delivered = 0
    for delivery in deliveries:
        event = delivery.event
        user = delivery.user
        if event.status == "cancelled" or not user.is_active or user.role == "bot":
            delivery.status = "skipped"
            continue
        notification = await safe_create_notification(
            session,
            recipient_user_id=user.id,
            notification_type="calendar_reminder",
            category="calendar",
            actor_username=event.created_by_username,
            actor_display_name=event.created_by_display_name,
            source_type="calendar_event",
            source_id=event.id,
            title_key="notification.calendar_reminder",
            body_preview=event.title,
            metadata={
                "calendar_event_id": event.id,
                "calendar_status": event.status,
                "calendar_event_type": event.event_type,
                "reminder_minutes": delivery.reminder_minutes,
            },
        )
        if notification is None:
            delivery.status = "failed"
            continue
        public = await serialize_event(session, event, user)
        await user_websocket_manager.broadcast_to_user(
            user.id,
            {
                "type": "calendar.reminder",
                "event": safe_event_payload(public),
                "reminder_minutes": delivery.reminder_minutes,
            },
        )
        delivery.status = "delivered"
        delivery.delivered_at = now_utc()
        delivered += 1
    await session.commit()
    return delivered


def http_error_from_calendar_error(exc: Exception) -> HTTPException:
    if isinstance(exc, CalendarConflictError):
        return HTTPException(status_code=status.HTTP_409_CONFLICT, detail=str(exc))
    if isinstance(exc, CalendarError):
        return HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail=str(exc))
    if isinstance(exc, PermissionError):
        return HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail=str(exc))
    if isinstance(exc, LookupError):
        return HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=str(exc))
    return HTTPException(status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail="Internal server error")
