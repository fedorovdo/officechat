import base64
import hashlib
import hmac
import json
import uuid
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from uuid import UUID

from fastapi import HTTPException, status
from redis.asyncio import Redis
from redis.exceptions import RedisError
from sqlalchemy import and_, func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.core.config import settings
from app.models.broadcast import BroadcastAnnouncement, BroadcastRecipient
from app.models.group import Group, GroupMember
from app.models.user import User
from app.schemas.broadcast import (
    AnnouncementPublic,
    BroadcastAudiencePayload,
    BroadcastCreate,
    BroadcastPreviewPublic,
    BroadcastPublic,
    BroadcastSendRequest,
    BroadcastUpdate,
)
from app.services.audit import record_audit_event
from app.services.websocket_manager import user_websocket_manager


class BroadcastError(ValueError):
    pass


class BroadcastConflictError(BroadcastError):
    pass


@dataclass
class AudienceResolution:
    users: list[User]
    group_count: int = 0
    excluded_disabled: int = 0
    excluded_bots: int = 0
    duplicates_removed: int = 0


def serialize_broadcast_public(announcement: BroadcastAnnouncement) -> BroadcastPublic:
    return BroadcastPublic(
        id=announcement.id,
        created_by_user_id=announcement.created_by_user_id,
        created_by_username=announcement.created_by_username,
        created_by_display_name=announcement.created_by_display_name,
        title=announcement.title,
        body=announcement.body,
        priority=announcement.priority,
        status=announcement.status,
        audience_type=announcement.audience_type,
        audience_definition=announcement.audience_definition,
        recipient_count=announcement.recipient_count,
        notified_count=announcement.notified_count,
        read_count=announcement.read_count,
        failed_count=announcement.failed_count,
        sent_at=announcement.sent_at,
        expires_at=announcement.expires_at,
        retracted_at=announcement.retracted_at,
        created_at=announcement.created_at,
        updated_at=announcement.updated_at,
    )


async def load_broadcast_public(session: AsyncSession, broadcast_id: UUID) -> BroadcastPublic:
    announcement = await session.scalar(
        select(BroadcastAnnouncement)
        .where(BroadcastAnnouncement.id == broadcast_id)
        .execution_options(populate_existing=True)
    )
    if announcement is None:
        raise LookupError("Broadcast not found")
    return serialize_broadcast_public(announcement)


def now_utc() -> datetime:
    return datetime.now(timezone.utc)


def normalize_audience(payload: BroadcastAudiencePayload) -> dict[str, object]:
    group_ids = sorted({str(group_id) for group_id in payload.group_ids})
    user_ids = sorted({str(user_id) for user_id in payload.user_ids})
    if payload.audience_type == "all_active_users":
        return {"group_ids": [], "user_ids": []}
    if payload.audience_type == "selected_groups":
        if not group_ids:
            raise BroadcastError("At least one group is required")
        return {"group_ids": group_ids, "user_ids": []}
    if not user_ids:
        raise BroadcastError("At least one user is required")
    return {"group_ids": [], "user_ids": user_ids}


def audience_hash(audience_type: str, audience_definition: dict[str, object]) -> str:
    payload = json.dumps(
        {"audience_type": audience_type, "audience_definition": audience_definition},
        sort_keys=True,
        separators=(",", ":"),
    )
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


def _b64encode(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).decode("ascii").rstrip("=")


def _b64decode(data: str) -> bytes:
    return base64.urlsafe_b64decode(data + "=" * (-len(data) % 4))


def sign_preview_token(actor_id: UUID, audience_type: str, audience_definition: dict[str, object]) -> tuple[str, str, datetime]:
    expires_at = now_utc() + timedelta(seconds=settings.broadcast_preview_ttl_seconds)
    digest = audience_hash(audience_type, audience_definition)
    payload = {
        "actor_id": str(actor_id),
        "audience_type": audience_type,
        "audience_hash": digest,
        "exp": int(expires_at.timestamp()),
    }
    payload_bytes = json.dumps(payload, sort_keys=True, separators=(",", ":")).encode("utf-8")
    signature = hmac.new(settings.app_secret_key.encode("utf-8"), payload_bytes, hashlib.sha256).digest()
    return f"{_b64encode(payload_bytes)}.{_b64encode(signature)}", digest, expires_at


def verify_preview_token(token: str, actor_id: UUID, audience_type: str, expected_hash: str) -> None:
    try:
        payload_part, signature_part = token.split(".", 1)
        payload_bytes = _b64decode(payload_part)
        expected_signature = hmac.new(settings.app_secret_key.encode("utf-8"), payload_bytes, hashlib.sha256).digest()
        if not hmac.compare_digest(expected_signature, _b64decode(signature_part)):
            raise BroadcastConflictError("Preview confirmation is invalid")
        payload = json.loads(payload_bytes)
    except Exception as exc:
        raise BroadcastConflictError("Preview confirmation is invalid") from exc
    if payload.get("actor_id") != str(actor_id):
        raise BroadcastConflictError("Preview confirmation is invalid")
    if payload.get("audience_type") != audience_type or payload.get("audience_hash") != expected_hash:
        raise BroadcastConflictError("Audience changed; preview again")
    if int(payload.get("exp", 0)) < int(now_utc().timestamp()):
        raise BroadcastConflictError("Preview expired; preview again")


def ensure_sender(actor: User) -> None:
    if not actor.is_active or actor.role == "bot" or actor.auth_provider == "bot":
        raise PermissionError("Permission required")


def validate_text(title: str, body: str) -> None:
    if not title.strip() or not body.strip():
        raise BroadcastError("Title and body are required")
    if len(title) > settings.broadcast_title_max_length:
        raise BroadcastError("Title is too long")
    if len(body) > settings.broadcast_body_max_length:
        raise BroadcastError("Body is too long")


def validate_expiration(expires_at: datetime | None) -> None:
    if expires_at is not None and expires_at <= now_utc():
        raise BroadcastError("Expiration must be in the future")


def human_user_filter() -> tuple:
    return (
        User.is_active.is_(True),
        User.role != "bot",
        User.auth_provider != "bot",
        User.is_system.is_(False),
    )


async def resolve_audience(
    session: AsyncSession,
    actor: User,
    audience_type: str,
    audience_definition: dict[str, object] | None,
) -> AudienceResolution:
    audience_definition = audience_definition or {}
    if audience_type == "all_active_users":
        rows = await session.execute(select(User).where(*human_user_filter()).order_by(User.username.asc()))
        return AudienceResolution(users=list(rows.scalars().all()))

    if audience_type == "selected_groups":
        group_ids = [UUID(str(value)) for value in audience_definition.get("group_ids", [])]
        rows = await session.execute(
            select(User)
            .join(GroupMember, GroupMember.user_id == User.id)
            .join(Group, Group.id == GroupMember.group_id)
            .where(Group.id.in_(group_ids), Group.is_active.is_(True))
            .order_by(User.username.asc())
        )
        raw_users = list(rows.scalars().all())
        unique: dict[UUID, User] = {}
        excluded_disabled = 0
        excluded_bots = 0
        for user in raw_users:
            if not user.is_active or user.is_system:
                excluded_disabled += 1
                continue
            if user.role == "bot" or user.auth_provider == "bot":
                excluded_bots += 1
                continue
            unique[user.id] = user
        return AudienceResolution(
            users=sorted(unique.values(), key=lambda item: item.username),
            group_count=len(group_ids),
            excluded_disabled=excluded_disabled,
            excluded_bots=excluded_bots,
            duplicates_removed=max(0, len(raw_users) - len(unique) - excluded_disabled - excluded_bots),
        )

    user_ids = [UUID(str(value)) for value in audience_definition.get("user_ids", [])]
    rows = await session.execute(select(User).where(User.id.in_(user_ids)).order_by(User.username.asc()))
    users = list(rows.scalars().all())
    by_id = {user.id: user for user in users}
    missing = [user_id for user_id in user_ids if user_id not in by_id]
    if missing:
        raise BroadcastError("Selected user not found")
    invalid = [user for user in users if not user.is_active or user.is_system or user.role == "bot" or user.auth_provider == "bot"]
    if invalid:
        raise BroadcastError("Selected users must be active human users")
    return AudienceResolution(users=users)


async def build_preview(session: AsyncSession, actor: User, payload: BroadcastAudiencePayload) -> BroadcastPreviewPublic:
    ensure_sender(actor)
    audience_definition = normalize_audience(payload)
    resolved = await resolve_audience(session, actor, payload.audience_type, audience_definition)
    if not resolved.users:
        raise BroadcastError("Audience has no recipients")
    if len(resolved.users) > settings.broadcast_max_recipients:
        raise BroadcastError("Too many recipients")
    token, digest, expires_at = sign_preview_token(actor.id, payload.audience_type, audience_definition)
    return BroadcastPreviewPublic(
        recipient_count=len(resolved.users),
        group_count=resolved.group_count,
        excluded_disabled=resolved.excluded_disabled,
        excluded_bots=resolved.excluded_bots,
        duplicates_removed=resolved.duplicates_removed,
        audience_hash=digest,
        confirmation_token=token,
        expires_at=expires_at,
    )


async def create_broadcast(session: AsyncSession, actor: User, payload: BroadcastCreate) -> BroadcastAnnouncement:
    ensure_sender(actor)
    validate_text(payload.title, payload.body)
    validate_expiration(payload.expires_at)
    audience_definition = normalize_audience(payload)
    announcement = BroadcastAnnouncement(
        id=uuid.uuid4(),
        created_by_user_id=actor.id,
        created_by_username=actor.username,
        created_by_display_name=actor.display_name,
        title=payload.title.strip(),
        body=payload.body.strip(),
        priority=payload.priority,
        status="draft",
        audience_type=payload.audience_type,
        audience_definition=audience_definition,
        expires_at=payload.expires_at,
    )
    session.add(announcement)
    await session.flush()
    return announcement


async def update_broadcast(
    session: AsyncSession,
    actor: User,
    announcement: BroadcastAnnouncement,
    payload: BroadcastUpdate,
) -> BroadcastAnnouncement:
    ensure_sender(actor)
    if announcement.status != "draft":
        raise BroadcastConflictError("Sent broadcast cannot be edited")
    title = payload.title if payload.title is not None else announcement.title
    body = payload.body if payload.body is not None else announcement.body
    validate_text(title, body)
    validate_expiration(payload.expires_at)
    announcement.title = title.strip()
    announcement.body = body.strip()
    if payload.priority is not None:
        announcement.priority = payload.priority
    if payload.audience_type is not None:
        announcement.audience_type = payload.audience_type
        announcement.audience_definition = normalize_audience(
            BroadcastAudiencePayload(
                audience_type=payload.audience_type,
                group_ids=payload.group_ids or [],
                user_ids=payload.user_ids or [],
            )
        )
    elif payload.group_ids is not None or payload.user_ids is not None:
        announcement.audience_definition = normalize_audience(
            BroadcastAudiencePayload(
                audience_type=announcement.audience_type,
                group_ids=payload.group_ids or [],
                user_ids=payload.user_ids or [],
            )
        )
    announcement.expires_at = payload.expires_at
    await session.flush()
    return announcement


def get_broadcast_client() -> Redis:
    return Redis.from_url(settings.valkey_url, decode_responses=True, socket_connect_timeout=2, socket_timeout=2)


async def enforce_rate_limit(actor: User, announcement: BroadcastAnnouncement) -> None:
    try:
        client = get_broadcast_client()
        try:
            limit = 3 if announcement.priority == "urgent" and announcement.audience_type == "all_active_users" else settings.broadcast_max_per_hour
            key = f"broadcast:rate:{actor.id}:{announcement.priority}:{announcement.audience_type}"
            count = int(await client.incr(key))
            if count == 1:
                await client.expire(key, 3600)
            if count > limit:
                raise BroadcastConflictError("Broadcast rate limit exceeded")
        finally:
            await client.aclose()
    except RedisError as exc:
        raise BroadcastConflictError("Broadcast rate limit unavailable") from exc


async def send_broadcast(
    session: AsyncSession,
    actor: User,
    announcement: BroadcastAnnouncement,
    payload: BroadcastSendRequest,
    request=None,
) -> tuple[BroadcastAnnouncement, list[UUID]]:
    ensure_sender(actor)
    if payload.idempotency_key:
        existing = await session.scalar(
            select(BroadcastAnnouncement).where(BroadcastAnnouncement.idempotency_key == payload.idempotency_key)
        )
        if existing is not None:
            return existing, []
    if announcement.status != "draft":
        raise BroadcastConflictError("Broadcast is not a draft")
    await enforce_rate_limit(actor, announcement)
    resolved = await resolve_audience(session, actor, announcement.audience_type, announcement.audience_definition)
    if len(resolved.users) != payload.expected_recipient_count:
        raise BroadcastConflictError("Audience changed; preview again")
    digest = audience_hash(announcement.audience_type, announcement.audience_definition or {})
    verify_preview_token(payload.confirmation_token, actor.id, announcement.audience_type, digest)
    if not resolved.users:
        raise BroadcastError("Audience has no recipients")
    if len(resolved.users) > settings.broadcast_max_recipients:
        raise BroadcastError("Too many recipients")

    sent_at = now_utc()
    online_ids = set(user_websocket_manager.connected_user_ids())
    notified = 0
    offline = 0
    for user in resolved.users:
        is_online = user.id in online_ids
        if is_online:
            notified += 1
        else:
            offline += 1
        session.add(
            BroadcastRecipient(
                id=uuid.uuid4(),
                broadcast_id=announcement.id,
                user_id=user.id,
                username_snapshot=user.username,
                display_name_snapshot=user.display_name,
                notification_status="notified" if is_online else "offline",
                notified_at=sent_at if is_online else None,
            )
        )
    announcement.status = "sent"
    announcement.recipient_count = len(resolved.users)
    announcement.notified_count = notified
    announcement.failed_count = 0
    announcement.sent_at = sent_at
    announcement.idempotency_key = payload.idempotency_key
    await record_audit_event(
        session,
        event_type="broadcast.sent",
        category="broadcasts",
        action="send",
        status="success",
        actor=actor,
        target_type="broadcast",
        target_id=announcement.id,
        target_label=str(announcement.id),
        details={
            "priority": announcement.priority,
            "audience_type": announcement.audience_type,
            "recipient_count": len(resolved.users),
            "group_count": resolved.group_count,
            "offline": offline,
        },
        request=request,
    )
    await session.flush()
    return announcement, [user.id for user in resolved.users]


async def unread_count(session: AsyncSession, user_id: UUID) -> int:
    return int(
        await session.scalar(
            select(func.count(BroadcastRecipient.id))
            .join(BroadcastAnnouncement, BroadcastAnnouncement.id == BroadcastRecipient.broadcast_id)
            .where(
                BroadcastRecipient.user_id == user_id,
                BroadcastRecipient.read_at.is_(None),
                BroadcastRecipient.dismissed_at.is_(None),
                BroadcastAnnouncement.status == "sent",
                or_(BroadcastAnnouncement.expires_at.is_(None), BroadcastAnnouncement.expires_at > now_utc()),
            )
        )
        or 0
    )


async def broadcast_created_events(session: AsyncSession, announcement: BroadcastAnnouncement, recipient_ids: list[UUID]) -> None:
    public = announcement_event_payload(announcement)
    for user_id in recipient_ids:
        await user_websocket_manager.broadcast_to_user(
            user_id,
            {
                "type": "announcement.created",
                "announcement": public,
                "unread_count": await unread_count(session, user_id),
            },
        )


async def broadcast_created_events_from_payload(
    session: AsyncSession,
    event_payload: dict[str, object],
    recipient_ids: list[UUID],
) -> None:
    for user_id in recipient_ids:
        await user_websocket_manager.broadcast_to_user(
            user_id,
            {
                "type": "announcement.created",
                "announcement": event_payload,
                "unread_count": await unread_count(session, user_id),
            },
        )


def announcement_event_payload(announcement: BroadcastAnnouncement) -> dict[str, object]:
    return {
        "id": str(announcement.id),
        "title": announcement.title,
        "priority": announcement.priority,
        "sent_at": announcement.sent_at.isoformat() if announcement.sent_at else None,
        "sender_user_id": str(announcement.created_by_user_id) if announcement.created_by_user_id else None,
        "sender_display_name": announcement.created_by_display_name,
        "is_read": False,
    }


def announcement_event_payload_from_public(announcement: BroadcastPublic) -> dict[str, object]:
    return {
        "id": str(announcement.id),
        "title": announcement.title,
        "priority": announcement.priority,
        "sent_at": announcement.sent_at.isoformat() if announcement.sent_at else None,
        "sender_user_id": str(announcement.created_by_user_id) if announcement.created_by_user_id else None,
        "sender_display_name": announcement.created_by_display_name,
        "is_read": False,
    }


async def get_sender_broadcast(session: AsyncSession, broadcast_id: UUID) -> BroadcastAnnouncement | None:
    return await session.get(BroadcastAnnouncement, broadcast_id)


async def list_sent_broadcasts(session: AsyncSession, actor: User, page: int, limit: int) -> tuple[list[BroadcastAnnouncement], int]:
    conditions = [] if actor.role == "superadmin" else [BroadcastAnnouncement.created_by_user_id == actor.id]
    total = int(await session.scalar(select(func.count(BroadcastAnnouncement.id)).where(*conditions)) or 0)
    rows = await session.execute(
        select(BroadcastAnnouncement)
        .where(*conditions)
        .order_by(BroadcastAnnouncement.created_at.desc())
        .offset((page - 1) * limit)
        .limit(limit)
    )
    return list(rows.scalars().all()), total


async def list_recipient_announcements(session: AsyncSession, user: User, page: int, limit: int) -> tuple[list[BroadcastRecipient], int]:
    conditions = (
        BroadcastRecipient.user_id == user.id,
        BroadcastRecipient.dismissed_at.is_(None),
        BroadcastAnnouncement.status.in_(("sent", "retracted")),
    )
    total = int(
        await session.scalar(
            select(func.count(BroadcastRecipient.id))
            .join(BroadcastAnnouncement, BroadcastAnnouncement.id == BroadcastRecipient.broadcast_id)
            .where(*conditions)
        )
        or 0
    )
    rows = await session.execute(
        select(BroadcastRecipient)
        .join(BroadcastAnnouncement, BroadcastAnnouncement.id == BroadcastRecipient.broadcast_id)
        .options(selectinload(BroadcastRecipient.broadcast))
        .where(*conditions)
        .order_by(BroadcastAnnouncement.sent_at.desc().nullslast(), BroadcastAnnouncement.created_at.desc())
        .offset((page - 1) * limit)
        .limit(limit)
    )
    return list(rows.scalars().all()), total


async def get_recipient_row(session: AsyncSession, user: User, broadcast_id: UUID) -> BroadcastRecipient | None:
    return await session.scalar(
        select(BroadcastRecipient)
        .options(selectinload(BroadcastRecipient.broadcast))
        .where(BroadcastRecipient.user_id == user.id, BroadcastRecipient.broadcast_id == broadcast_id)
    )


def serialize_announcement(recipient: BroadcastRecipient) -> AnnouncementPublic:
    broadcast = recipient.broadcast
    is_retracted = broadcast.status == "retracted"
    body = None if is_retracted else broadcast.body
    preview = "Announcement retracted" if is_retracted else broadcast.body[:180]
    return AnnouncementPublic(
        id=broadcast.id,
        title=broadcast.title,
        body=body,
        priority=broadcast.priority,
        status=broadcast.status,
        sender=broadcast.created_by_display_name,
        sent_at=broadcast.sent_at,
        expires_at=broadcast.expires_at,
        is_read=recipient.read_at is not None,
        read_at=recipient.read_at,
        dismissed_at=recipient.dismissed_at,
        preview=preview,
    )


async def mark_announcement_read(session: AsyncSession, user: User, broadcast_id: UUID) -> tuple[AnnouncementPublic, int]:
    recipient = await get_recipient_row(session, user, broadcast_id)
    if recipient is None:
        raise LookupError("Announcement not found")
    if recipient.read_at is None:
        recipient.read_at = now_utc()
        broadcast = recipient.broadcast
        broadcast.read_count = int(broadcast.read_count or 0) + 1
        await session.flush()
    count = await unread_count(session, user.id)
    return serialize_announcement(recipient), count


async def dismiss_announcement(session: AsyncSession, user: User, broadcast_id: UUID) -> tuple[AnnouncementPublic, int]:
    recipient = await get_recipient_row(session, user, broadcast_id)
    if recipient is None:
        raise LookupError("Announcement not found")
    if recipient.dismissed_at is None:
        recipient.dismissed_at = now_utc()
        await session.flush()
    count = await unread_count(session, user.id)
    return serialize_announcement(recipient), count


async def retract_broadcast(session: AsyncSession, actor: User, announcement: BroadcastAnnouncement, request=None) -> list[UUID]:
    if announcement.status not in {"sent", "partially_failed"}:
        raise BroadcastConflictError("Only sent broadcasts can be retracted")
    if actor.role != "superadmin" and announcement.created_by_user_id != actor.id:
        raise PermissionError("Only original sender or superadmin can retract")
    announcement.status = "retracted"
    announcement.retracted_at = now_utc()
    rows = await session.execute(select(BroadcastRecipient.user_id).where(BroadcastRecipient.broadcast_id == announcement.id))
    recipient_ids = [user_id for user_id in rows.scalars().all() if user_id is not None]
    await record_audit_event(
        session,
        event_type="broadcast.retracted",
        category="broadcasts",
        action="retract",
        status="success",
        actor=actor,
        target_type="broadcast",
        target_id=announcement.id,
        target_label=str(announcement.id),
        details={
            "priority": announcement.priority,
            "audience_type": announcement.audience_type,
            "recipient_count": announcement.recipient_count,
        },
        request=request,
    )
    await session.flush()
    return recipient_ids


async def broadcast_retracted_events(session: AsyncSession, announcement_id: UUID, recipient_ids: list[UUID]) -> None:
    for user_id in recipient_ids:
        await user_websocket_manager.broadcast_to_user(
            user_id,
            {
                "type": "announcement.retracted",
                "announcement_id": str(announcement_id),
                "unread_count": await unread_count(session, user_id),
            },
        )


async def stats_for_broadcast(session: AsyncSession, announcement: BroadcastAnnouncement) -> dict[str, object]:
    rows = await session.execute(
        select(BroadcastRecipient.notification_status, BroadcastRecipient.read_at)
        .where(BroadcastRecipient.broadcast_id == announcement.id)
    )
    recipients = 0
    notified = 0
    offline = 0
    failed = 0
    read = 0
    for status_value, read_at in rows.all():
        recipients += 1
        if status_value == "notified":
            notified += 1
        elif status_value == "offline":
            offline += 1
        elif status_value == "failed":
            failed += 1
        if read_at is not None:
            read += 1
    unread = max(0, recipients - read)
    return {
        "recipients": recipients,
        "notified": notified,
        "offline": offline,
        "read": read,
        "unread": unread,
        "failed": failed,
        "read_percentage": round((read / recipients * 100) if recipients else 0, 2),
    }


def http_error_from_broadcast_error(exc: Exception) -> HTTPException:
    if isinstance(exc, BroadcastConflictError):
        return HTTPException(status_code=status.HTTP_409_CONFLICT, detail=str(exc))
    if isinstance(exc, BroadcastError):
        return HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail=str(exc))
    if isinstance(exc, PermissionError):
        return HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail=str(exc))
    if isinstance(exc, LookupError):
        return HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=str(exc))
    return HTTPException(status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail="Internal server error")
