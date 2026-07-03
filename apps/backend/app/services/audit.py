import hashlib
import logging
import re
import time
from dataclasses import dataclass
from datetime import datetime
from typing import Any
from uuid import UUID

from fastapi import Request
from sqlalchemy import func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.session import AsyncSessionLocal
from app.models.audit import AuditEvent
from app.models.user import User

logger = logging.getLogger("uvicorn.error")

SENSITIVE_KEYS = {
    "password", "password_hash", "new_password", "old_password", "token", "access_token",
    "refresh_token", "authorization", "secret", "bot_token", "webhook_token", "jwt", "cookie",
    "body", "message_body", "private_message", "attachment_content", "storage_path", "avatar_path",
}
JWT_PATTERN = re.compile(r"\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}(?:\.[A-Za-z0-9_-]+)?\b")
BEARER_PATTERN = re.compile(r"(?i)\bBearer\s+[A-Za-z0-9._~+/-]+=*\b")
MAX_DETAIL_STRING = 2000
_security_event_times: dict[str, float] = {}


def sanitize_audit_value(value: Any, key: str | None = None) -> Any:
    normalized_key = key.lower().replace("-", "_") if key else None
    if normalized_key in SENSITIVE_KEYS:
        return "[REDACTED]"
    if isinstance(value, dict):
        return {str(item_key): sanitize_audit_value(item_value, str(item_key)) for item_key, item_value in value.items()}
    if isinstance(value, (list, tuple, set)):
        return [sanitize_audit_value(item) for item in value]
    if isinstance(value, UUID):
        return str(value)
    if isinstance(value, datetime):
        return value.isoformat()
    if isinstance(value, str):
        sanitized = JWT_PATTERN.sub("[REDACTED]", value)
        sanitized = BEARER_PATTERN.sub("Bearer [REDACTED]", sanitized)
        return sanitized[:MAX_DETAIL_STRING]
    if value is None or isinstance(value, (bool, int, float)):
        return value
    return str(value)[:MAX_DETAIL_STRING]


def token_fingerprint(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8", errors="ignore")).hexdigest()[:12]


def should_record_security_event(key: str, window_seconds: int = 60) -> bool:
    now = time.monotonic()
    previous = _security_event_times.get(key)
    if previous is not None and now - previous < window_seconds:
        return False
    _security_event_times[key] = now
    if len(_security_event_times) > 2000:
        cutoff = now - window_seconds
        for item_key, recorded_at in list(_security_event_times.items()):
            if recorded_at < cutoff:
                _security_event_times.pop(item_key, None)
    return True


def request_context(request: Request | None) -> tuple[str | None, str | None, str | None]:
    if request is None:
        return None, None, None
    source_ip = request.client.host[:64] if request.client else None
    user_agent = request.headers.get("user-agent")
    request_id = getattr(request.state, "request_id", None)
    return source_ip, user_agent[:500] if user_agent else None, request_id


async def record_audit_event(
    session: AsyncSession,
    *,
    event_type: str,
    category: str,
    action: str,
    status: str,
    actor: User | None = None,
    actor_username: str | None = None,
    target_type: str | None = None,
    target_id: UUID | str | None = None,
    target_label: str | None = None,
    details: dict[str, Any] | None = None,
    error_code: str | None = None,
    error_message: str | None = None,
    request: Request | None = None,
) -> AuditEvent:
    source_ip, user_agent, request_id = request_context(request)
    event = AuditEvent(
        actor_user_id=actor.id if actor else None,
        actor_username=actor.username if actor else (actor_username[:64] if actor_username else None),
        actor_display_name=actor.display_name if actor else None,
        actor_role=actor.role if actor else None,
        event_type=event_type[:128],
        category=category[:64],
        action=action[:64],
        status=status[:32],
        target_type=target_type[:64] if target_type else None,
        target_id=str(target_id)[:255] if target_id is not None else None,
        target_label=target_label[:500] if target_label else None,
        source_ip=source_ip,
        user_agent=user_agent,
        request_id=request_id,
        details=sanitize_audit_value(details) if details is not None else None,
        error_code=error_code[:128] if error_code else None,
        error_message=sanitize_audit_value(error_message)[:1000] if error_message else None,
    )
    session.add(event)
    await session.flush()
    return event


async def record_audit_event_best_effort(**kwargs: Any) -> None:
    try:
        async with AsyncSessionLocal() as session:
            await record_audit_event(session, **kwargs)
            await session.commit()
    except Exception:
        logger.exception("Audit event persistence failed for %s", kwargs.get("event_type", "unknown"))


@dataclass(slots=True)
class AuditEventQuery:
    page: int = 1
    limit: int = 50
    date_from: datetime | None = None
    date_to: datetime | None = None
    actor_user_id: UUID | None = None
    actor_username: str | None = None
    category: str | None = None
    event_type: str | None = None
    status: str | None = None
    target_type: str | None = None
    target_id: str | None = None
    search: str | None = None


def audit_conditions(query: AuditEventQuery) -> list[Any]:
    conditions: list[Any] = []
    if query.date_from:
        conditions.append(AuditEvent.created_at >= query.date_from)
    if query.date_to:
        conditions.append(AuditEvent.created_at <= query.date_to)
    if query.actor_user_id:
        conditions.append(AuditEvent.actor_user_id == query.actor_user_id)
    if query.actor_username:
        conditions.append(AuditEvent.actor_username.ilike(f"%{query.actor_username.strip()}%"))
    if query.category:
        conditions.append(AuditEvent.category == query.category)
    if query.event_type:
        conditions.append(AuditEvent.event_type == query.event_type)
    if query.status:
        conditions.append(AuditEvent.status == query.status)
    if query.target_type:
        conditions.append(AuditEvent.target_type == query.target_type)
    if query.target_id:
        conditions.append(AuditEvent.target_id == query.target_id)
    if query.search:
        pattern = f"%{query.search.strip()}%"
        conditions.append(or_(
            AuditEvent.event_type.ilike(pattern),
            AuditEvent.actor_username.ilike(pattern),
            AuditEvent.actor_display_name.ilike(pattern),
            AuditEvent.target_label.ilike(pattern),
            AuditEvent.request_id.ilike(pattern),
        ))
    return conditions


async def list_audit_events(session: AsyncSession, query: AuditEventQuery) -> tuple[list[AuditEvent], int]:
    conditions = audit_conditions(query)
    total = int(await session.scalar(select(func.count(AuditEvent.id)).where(*conditions)) or 0)
    result = await session.execute(
        select(AuditEvent)
        .where(*conditions)
        .order_by(AuditEvent.created_at.desc(), AuditEvent.id.desc())
        .offset((query.page - 1) * query.limit)
        .limit(query.limit)
    )
    return list(result.scalars().all()), total


async def export_audit_events(session: AsyncSession, query: AuditEventQuery, max_rows: int) -> list[AuditEvent]:
    result = await session.execute(
        select(AuditEvent)
        .where(*audit_conditions(query))
        .order_by(AuditEvent.created_at.desc(), AuditEvent.id.desc())
        .limit(max_rows)
    )
    return list(result.scalars().all())


async def get_audit_event(session: AsyncSession, event_id: UUID) -> AuditEvent | None:
    return await session.get(AuditEvent, event_id)


async def get_audit_filter_options(session: AsyncSession) -> tuple[list[str], list[str], list[str]]:
    async def values(column: Any) -> list[str]:
        result = await session.execute(select(column).distinct().where(column.is_not(None)).order_by(column))
        return [str(item) for item in result.scalars().all()]

    return await values(AuditEvent.category), await values(AuditEvent.status), await values(AuditEvent.event_type)
