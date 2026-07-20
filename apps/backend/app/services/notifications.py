import logging
from datetime import datetime, timedelta, timezone
from typing import Any
from uuid import UUID

from sqlalchemy import delete, func, or_, select, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.core.config import settings
from app.models.notification import Notification, NotificationPreference
from app.models.user import User
from app.schemas.notification import (
    NotificationPage,
    NotificationPreferencesPublic,
    NotificationPreferencesUpdate,
    NotificationPublic,
)
from app.services.websocket_manager import user_websocket_manager

logger = logging.getLogger("uvicorn.error")

TYPE_TO_PREFERENCE = {
    "mention": "mentions_enabled",
    "reply": "replies_enabled",
    "reaction": "reactions_enabled",
    "direct_message": "direct_messages_enabled",
    "group_message": "group_messages_enabled",
    "discussion_message": "discussion_messages_enabled",
    "announcement": "announcements_enabled",
    "pin": "pins_enabled",
    "calendar_created": "calendar_events_enabled",
    "calendar_updated": "calendar_changes_enabled",
    "calendar_rescheduled": "calendar_changes_enabled",
    "calendar_cancelled": "calendar_changes_enabled",
    "calendar_reminder": "calendar_reminders_enabled",
    "system": "system_enabled",
}
SAFE_METADATA_KEYS = {
    "group_id",
    "group_name",
    "group_slug",
    "conversation_id",
    "discussion_id",
    "source_group_id",
    "announcement_id",
    "calendar_event_id",
    "calendar_status",
    "calendar_event_type",
    "reminder_minutes",
    "priority",
    "emoji",
    "source_label",
}


def now_utc() -> datetime:
    return datetime.now(timezone.utc)


def sanitize_preview(value: str | None, *, max_length: int = 180) -> str | None:
    if value is None:
        return None
    preview = " ".join(value.strip().split())
    if not preview:
        return None
    return preview[: max_length - 3] + "..." if len(preview) > max_length else preview


def sanitize_metadata(metadata: dict[str, object] | None) -> dict[str, object] | None:
    if not metadata:
        return None
    safe: dict[str, object] = {}
    for key, value in metadata.items():
        if key not in SAFE_METADATA_KEYS:
            continue
        if isinstance(value, UUID):
            safe[key] = str(value)
        elif value is None or isinstance(value, (str, int, float, bool)):
            safe[key] = value
    return safe or None


async def get_or_create_preferences(session: AsyncSession, user_id: UUID) -> NotificationPreference:
    preferences = await session.scalar(select(NotificationPreference).where(NotificationPreference.user_id == user_id))
    if preferences is None:
        preferences = NotificationPreference(user_id=user_id)
        session.add(preferences)
        await session.flush()
    return preferences


def preferences_allow(preferences: NotificationPreference, notification_type: str) -> bool:
    if notification_type == "system":
        return True
    field_name = TYPE_TO_PREFERENCE.get(notification_type)
    return bool(getattr(preferences, field_name, False)) if field_name else False


def build_dedupe_key(
    recipient_user_id: UUID,
    notification_type: str,
    source_type: str | None,
    source_id: str | UUID | None,
    metadata: dict[str, object] | None = None,
) -> str:
    source_value = str(source_id) if source_id is not None else "-"
    if notification_type == "reaction":
        emoji = str((metadata or {}).get("emoji", ""))
        actor = str((metadata or {}).get("actor_user_id", ""))
        return f"{recipient_user_id}:reaction:{source_type}:{source_value}:{emoji}:{actor}"
    return f"{recipient_user_id}:{notification_type}:{source_type or '-'}:{source_value}"


async def unread_count(session: AsyncSession, user_id: UUID) -> int:
    return int(
        await session.scalar(
            select(func.count(Notification.id)).where(
                Notification.user_id == user_id,
                Notification.is_read.is_(False),
                Notification.is_dismissed.is_(False),
            )
        )
        or 0
    )


def serialize_notification(notification: Notification) -> NotificationPublic:
    actor = notification.actor
    return NotificationPublic(
        id=notification.id,
        type=notification.type,
        category=notification.category,
        source_type=notification.source_type,
        source_id=notification.source_id,
        chat_type=notification.chat_type,
        chat_id=notification.chat_id,
        message_id=notification.message_id,
        actor={
            "id": notification.actor_user_id,
            "username": (actor.username if actor else None) or notification.actor_username,
            "display_name": (actor.display_name if actor else None) or notification.actor_display_name,
            "avatar_url": actor.avatar_url if actor else None,
        },
        title_key=notification.title_key,
        body_preview=notification.body_preview,
        metadata=notification.meta,
        is_read=notification.is_read,
        read_at=notification.read_at,
        is_dismissed=notification.is_dismissed,
        dismissed_at=notification.dismissed_at,
        created_at=notification.created_at,
        updated_at=notification.updated_at,
    )


def serialize_preferences(preferences: NotificationPreference) -> NotificationPreferencesPublic:
    return NotificationPreferencesPublic.model_validate(preferences)


async def redact_message_notification_previews(session: AsyncSession, message_id: UUID) -> None:
    await session.execute(
        update(Notification)
        .where(Notification.message_id == message_id)
        .values(body_preview=None)
    )


async def broadcast_notification_event(session: AsyncSession, user_id: UUID, event: dict[str, object]) -> None:
    event["unread_count"] = await unread_count(session, user_id)
    await user_websocket_manager.broadcast_to_user(user_id, event)


async def safe_broadcast_notification_event(session: AsyncSession, user_id: UUID, event: dict[str, object]) -> None:
    try:
        await broadcast_notification_event(session, user_id, event)
    except Exception:
        logger.exception("Notification websocket broadcast failed user_id=%s type=%s", user_id, event.get("type"))


async def create_notification(
    session: AsyncSession,
    recipient_user_id: UUID,
    notification_type: str,
    category: str,
    actor: User | None = None,
    actor_username: str | None = None,
    actor_display_name: str | None = None,
    source_type: str | None = None,
    source_id: str | UUID | None = None,
    chat_type: str | None = None,
    chat_id: UUID | None = None,
    message_id: UUID | None = None,
    title_key: str = "notification.system",
    body_preview: str | None = None,
    metadata: dict[str, object] | None = None,
) -> Notification | None:
    recipient = await session.get(User, recipient_user_id)
    if recipient is None or not recipient.is_active or recipient.role == "bot":
        return None
    if actor is not None and actor.id == recipient_user_id and notification_type != "system":
        return None

    preferences = await get_or_create_preferences(session, recipient_user_id)
    if not preferences_allow(preferences, notification_type):
        await session.commit()
        return None

    safe_metadata = sanitize_metadata(metadata)
    if notification_type == "reaction" and actor is not None:
        safe_metadata = {**(safe_metadata or {}), "actor_user_id": str(actor.id)}
    dedupe_key = build_dedupe_key(recipient_user_id, notification_type, source_type, source_id, safe_metadata)
    existing = await session.scalar(select(Notification).where(Notification.dedupe_key == dedupe_key))
    if existing is not None:
        await session.commit()
        return existing

    notification = Notification(
        user_id=recipient_user_id,
        type=notification_type,
        category=category,
        source_type=source_type,
        source_id=str(source_id) if source_id is not None else None,
        chat_type=chat_type,
        chat_id=chat_id,
        message_id=message_id,
        actor_user_id=actor.id if actor else None,
        actor_username=actor.username if actor else actor_username,
        actor_display_name=actor.display_name if actor else actor_display_name,
        title_key=title_key,
        body_preview=sanitize_preview(body_preview),
        meta=safe_metadata,
        dedupe_key=dedupe_key,
    )
    session.add(notification)
    try:
        await session.commit()
    except IntegrityError:
        await session.rollback()
        return await session.scalar(select(Notification).where(Notification.dedupe_key == dedupe_key))
    await session.refresh(notification, ["actor", "created_at", "updated_at"])
    public = serialize_notification(notification)
    await safe_broadcast_notification_event(
        session,
        recipient_user_id,
        {
            "type": "notification.created",
            "notification": public.model_dump(mode="json"),
        },
    )
    return notification


async def safe_create_notification(session: AsyncSession, **kwargs: Any) -> Notification | None:
    try:
        return await create_notification(session, **kwargs)
    except Exception:
        logger.exception("Notification creation failed type=%s recipient=%s", kwargs.get("notification_type"), kwargs.get("recipient_user_id"))
        try:
            await session.rollback()
        except Exception:
            logger.exception("Notification rollback failed")
        return None


async def list_notifications(
    session: AsyncSession,
    user_id: UUID,
    *,
    limit: int,
    cursor: str | None = None,
    category: str | None = None,
    notification_type: str | None = None,
    unread_only: bool = False,
    include_dismissed: bool = False,
) -> NotificationPage:
    conditions = [Notification.user_id == user_id]
    if category:
        conditions.append(Notification.category == category)
    if notification_type:
        conditions.append(Notification.type == notification_type)
    if unread_only:
        conditions.append(Notification.is_read.is_(False))
    if not include_dismissed:
        conditions.append(Notification.is_dismissed.is_(False))
    if cursor:
        try:
            cursor_created_at, cursor_id = cursor.split("|", 1)
            cursor_dt = datetime.fromisoformat(cursor_created_at)
            cursor_uuid = UUID(cursor_id)
            conditions.append(
                or_(
                    Notification.created_at < cursor_dt,
                    (Notification.created_at == cursor_dt) & (Notification.id < cursor_uuid),
                )
            )
        except ValueError:
            pass

    result = await session.execute(
        select(Notification)
        .options(selectinload(Notification.actor))
        .where(*conditions)
        .order_by(Notification.created_at.desc(), Notification.id.desc())
        .limit(limit + 1)
    )
    rows = list(result.scalars().all())
    next_cursor = None
    if len(rows) > limit:
        last = rows[limit - 1]
        next_cursor = f"{last.created_at.isoformat()}|{last.id}"
        rows = rows[:limit]
    return NotificationPage(items=[serialize_notification(row) for row in rows], next_cursor=next_cursor)


async def get_user_notification(session: AsyncSession, user_id: UUID, notification_id: UUID) -> Notification | None:
    return await session.scalar(
        select(Notification)
        .options(selectinload(Notification.actor))
        .where(Notification.id == notification_id, Notification.user_id == user_id)
    )


async def mark_notification_read(session: AsyncSession, user_id: UUID, notification_id: UUID) -> NotificationPublic:
    notification = await get_user_notification(session, user_id, notification_id)
    if notification is None:
        raise LookupError("Notification not found")
    if not notification.is_read:
        notification.is_read = True
        notification.read_at = now_utc()
        await session.flush()
        await session.refresh(notification, ["actor", "updated_at"])
    public = serialize_notification(notification)
    await session.commit()
    await safe_broadcast_notification_event(
        session,
        user_id,
        {"type": "notification.read", "notification_id": str(notification.id)},
    )
    return public


async def mark_all_notifications_read(session: AsyncSession, user_id: UUID, category: str | None = None) -> int:
    conditions = [Notification.user_id == user_id, Notification.is_read.is_(False)]
    if category:
        conditions.append(Notification.category == category)
    rows = await session.execute(select(Notification).where(*conditions))
    notifications = list(rows.scalars().all())
    timestamp = now_utc()
    for notification in notifications:
        notification.is_read = True
        notification.read_at = timestamp
    await session.commit()
    await safe_broadcast_notification_event(
        session,
        user_id,
        {"type": "notifications.read_all", "category": category},
    )
    return len(notifications)


async def mark_source_notification_read(
    session: AsyncSession,
    user_id: UUID,
    source_type: str,
    source_id: str | UUID,
) -> int:
    rows = await session.execute(
        select(Notification).where(
            Notification.user_id == user_id,
            Notification.source_type == source_type,
            Notification.source_id == str(source_id),
            Notification.is_read.is_(False),
        )
    )
    notifications = list(rows.scalars().all())
    timestamp = now_utc()
    for notification in notifications:
        notification.is_read = True
        notification.read_at = timestamp
    await session.commit()
    for notification in notifications:
        await safe_broadcast_notification_event(
            session,
            user_id,
            {"type": "notification.read", "notification_id": str(notification.id)},
        )
    return len(notifications)


async def dismiss_notification(session: AsyncSession, user_id: UUID, notification_id: UUID) -> NotificationPublic:
    notification = await get_user_notification(session, user_id, notification_id)
    if notification is None:
        raise LookupError("Notification not found")
    if not notification.is_dismissed:
        notification.is_dismissed = True
        notification.dismissed_at = now_utc()
        await session.flush()
        await session.refresh(notification, ["actor", "updated_at"])
    public = serialize_notification(notification)
    await session.commit()
    await safe_broadcast_notification_event(
        session,
        user_id,
        {"type": "notification.dismissed", "notification_id": str(notification.id)},
    )
    return public


async def update_preferences(
    session: AsyncSession,
    user_id: UUID,
    payload: NotificationPreferencesUpdate,
) -> NotificationPreferencesPublic:
    preferences = await get_or_create_preferences(session, user_id)
    for field_name, value in payload.model_dump(exclude_unset=True).items():
        if field_name == "system_enabled":
            setattr(preferences, field_name, True)
        elif hasattr(preferences, field_name):
            setattr(preferences, field_name, value)
    await session.flush()
    await session.refresh(preferences)
    public = serialize_preferences(preferences)
    await session.commit()
    try:
        await user_websocket_manager.broadcast_to_user(
            user_id,
            {
                "type": "notification.preferences_updated",
                "preferences": public.model_dump(mode="json"),
            },
        )
    except Exception:
        logger.exception("Notification preferences websocket broadcast failed user_id=%s", user_id)
    return public


async def cleanup_old_notifications(session: AsyncSession, user_id: UUID | None = None) -> int:
    cutoff = now_utc() - timedelta(days=settings.notification_retention_days)
    conditions = [Notification.created_at < cutoff]
    if user_id is not None:
        conditions.append(Notification.user_id == user_id)
    result = await session.execute(delete(Notification).where(*conditions).returning(Notification.id))
    deleted = len(result.scalars().all())
    await session.commit()
    return deleted
