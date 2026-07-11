import asyncio
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

from fastapi import Request
from types import SimpleNamespace

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings as app_settings
from app.models.attachment import DirectMessageAttachment, DiscussionMessageAttachment, MessageAttachment
from app.models.direct import DirectMessage
from app.models.discussion import DiscussionMessage
from app.models.message import Message
from app.models.retention import RetentionAudit, RetentionSettings
from app.models.user import User
from app.schemas.retention import (
    RetentionRunResult,
    RetentionSettingsUpdate,
    RetentionSummary,
    StorageMessageCounts,
    StorageStats,
)
from app.services.audit import record_audit_event
from app.services.attachments import resolve_attachment_path
from app.services.pins import delete_pins_for_messages

RETENTION_SETTINGS_ID = 1
retention_cleanup_lock = asyncio.Lock()

MESSAGE_MODELS: tuple[tuple[type[Any], str], ...] = (
    (Message, "group_messages_archived"),
    (DirectMessage, "direct_messages_archived"),
    (DiscussionMessage, "discussion_messages_archived"),
)
ATTACHMENT_MODELS = (MessageAttachment, DirectMessageAttachment, DiscussionMessageAttachment)
PIN_CHAT_TYPE_BY_MODEL = {
    Message: "group",
    DirectMessage: "direct",
    DiscussionMessage: "discussion",
}


async def get_retention_settings(session: AsyncSession) -> RetentionSettings:
    current = await session.get(RetentionSettings, RETENTION_SETTINGS_ID)
    if current is not None:
        return current
    current = RetentionSettings(id=RETENTION_SETTINGS_ID)
    session.add(current)
    await session.commit()
    await session.refresh(current)
    return current


def settings_snapshot(current: RetentionSettings) -> dict[str, object]:
    return {
        "retention_enabled": current.retention_enabled,
        "active_history_days": current.active_history_days,
        "archive_enabled": current.archive_enabled,
        "attachment_retention_days": current.attachment_retention_days,
        "delete_archived_after_days": current.delete_archived_after_days,
        "cleanup_batch_size": current.cleanup_batch_size,
        "cleanup_interval_hours": current.cleanup_interval_hours,
    }


async def record_retention_audit(
    session: AsyncSession,
    action: str,
    actor_user_id: uuid.UUID | None,
    details: dict[str, object],
) -> None:
    session.add(RetentionAudit(action=action, actor_user_id=actor_user_id, details=details))


async def update_retention_settings(
    session: AsyncSession,
    current: RetentionSettings,
    payload: RetentionSettingsUpdate,
    actor: User,
    request: Request | None = None,
) -> RetentionSettings:
    old_values = settings_snapshot(current)
    for field, value in payload.model_dump(exclude_unset=True).items():
        setattr(current, field, value)
    current.updated_by_user_id = actor.id
    current.updated_at = datetime.now(timezone.utc)
    await record_retention_audit(
        session,
        "settings.updated",
        actor.id,
        {"old": old_values, "new": settings_snapshot(current)},
    )
    await record_audit_event(
        session, event_type="retention.settings_updated", category="retention", action="update_settings",
        status="success", actor=actor, target_type="retention_settings", target_id=str(current.id),
        target_label="retention", details={"old": old_values, "new": settings_snapshot(current)}, request=request,
    )
    await session.commit()
    await session.refresh(current)
    return current


def archive_cutoff(current: RetentionSettings, now: datetime) -> datetime | None:
    if not current.archive_enabled or current.active_history_days <= 0:
        return None
    return now - timedelta(days=current.active_history_days)


def attachment_cutoff(current: RetentionSettings, now: datetime) -> datetime | None:
    if current.attachment_retention_days is None:
        return None
    return now - timedelta(days=current.attachment_retention_days)


async def count_matching(session: AsyncSession, model: type[Any], *conditions: Any) -> int:
    result = await session.execute(select(func.count(model.id)).where(*conditions))
    return int(result.scalar_one())


async def calculate_retention_summary(
    session: AsyncSession,
    current: RetentionSettings,
    now: datetime | None = None,
) -> RetentionSummary:
    checked_at = now or datetime.now(timezone.utc)
    summary = RetentionSummary()
    message_cutoff = archive_cutoff(current, checked_at)
    if message_cutoff is not None:
        for model, field_name in MESSAGE_MODELS:
            count = await count_matching(
                session,
                model,
                model.is_archived.is_(False),
                model.created_at < message_cutoff,
            )
            setattr(summary, field_name, count)

    file_cutoff = attachment_cutoff(current, checked_at)
    if file_cutoff is not None:
        for model in ATTACHMENT_MODELS:
            stream = await session.stream(
                select(model.storage_path).where(
                    model.file_available.is_(True),
                    model.created_at < file_cutoff,
                )
            )
            async for (storage_path,) in stream:
                try:
                    path = resolve_attachment_path(SimpleNamespace(storage_path=storage_path))
                    if path.exists() and path.is_file():
                        summary.attachments_deleted += 1
                    else:
                        summary.files_missing += 1
                except (OSError, ValueError):
                    summary.files_missing += 1
    return summary


async def archive_model_batches(
    session: AsyncSession,
    model: type[Any],
    cutoff: datetime,
    batch_size: int,
) -> int:
    archived_count = 0
    while True:
        result = await session.execute(
            select(model)
            .where(model.is_archived.is_(False), model.created_at < cutoff)
            .order_by(model.created_at.asc(), model.id.asc())
            .limit(batch_size)
        )
        rows = list(result.scalars().all())
        if not rows:
            return archived_count
        archived_at = datetime.now(timezone.utc)
        for row in rows:
            row.is_archived = True
            row.archived_at = archived_at
        message_ids = [row.id for row in rows if getattr(row, "id", None) is not None]
        await delete_pins_for_messages(session, PIN_CHAT_TYPE_BY_MODEL[model], message_ids)
        await session.commit()
        archived_count += len(rows)


async def cleanup_attachment_model_batches(
    session: AsyncSession,
    model: type[Any],
    cutoff: datetime,
    batch_size: int,
) -> tuple[int, int]:
    deleted_count = 0
    missing_count = 0
    while True:
        result = await session.execute(
            select(model)
            .where(model.file_available.is_(True), model.created_at < cutoff)
            .order_by(model.created_at.asc(), model.id.asc())
            .limit(batch_size)
        )
        rows = list(result.scalars().all())
        if not rows:
            return deleted_count, missing_count

        moved_files: list[tuple[Path, Path]] = []
        deleted_at = datetime.now(timezone.utc)
        try:
            for row in rows:
                path = resolve_attachment_path(row)
                if path.exists() and path.is_file():
                    temporary_path = path.with_name(f".{path.name}.retention-{uuid.uuid4().hex}.tmp")
                    path.replace(temporary_path)
                    moved_files.append((path, temporary_path))
                    deleted_count += 1
                else:
                    missing_count += 1
                row.file_available = False
                row.file_deleted_at = deleted_at
            await session.commit()
        except BaseException:
            await session.rollback()
            for original_path, temporary_path in moved_files:
                if temporary_path.exists():
                    temporary_path.replace(original_path)
            raise
        for _, temporary_path in moved_files:
            temporary_path.unlink(missing_ok=True)


async def run_retention_cleanup(
    session: AsyncSession,
    current: RetentionSettings,
    actor: User,
    request: Request | None = None,
) -> RetentionRunResult:
    now = datetime.now(timezone.utc)
    recent_running_cleanup = (
        current.last_cleanup_status == "running"
        and current.last_cleanup_started_at is not None
        and now - current.last_cleanup_started_at < timedelta(hours=6)
    )
    if retention_cleanup_lock.locked() or recent_running_cleanup:
        raise RuntimeError("Retention cleanup is already running")
    if not current.retention_enabled:
        raise PermissionError("Retention is disabled")
    preview_result = await session.execute(
        select(RetentionAudit)
        .where(RetentionAudit.action == "cleanup.dry_run")
        .order_by(RetentionAudit.created_at.desc())
        .limit(1)
    )
    latest_preview = preview_result.scalar_one_or_none()
    if (
        latest_preview is None
        or latest_preview.created_at < current.updated_at
        or latest_preview.details.get("settings") != settings_snapshot(current)
    ):
        raise PermissionError("Run cleanup preview before cleanup")

    async with retention_cleanup_lock:
        current.last_cleanup_started_at = now
        current.last_cleanup_finished_at = None
        current.last_cleanup_status = "running"
        current.last_cleanup_summary = None
        await record_retention_audit(session, "cleanup.started", actor.id, {"settings": settings_snapshot(current)})
        await record_audit_event(
            session, event_type="retention.cleanup_started", category="retention", action="cleanup",
            status="success", actor=actor, target_type="retention_settings", target_id=str(current.id),
            target_label="retention", details={"settings": settings_snapshot(current)}, request=request,
        )
        await session.commit()

        summary = RetentionSummary()
        message_cutoff = archive_cutoff(current, now)
        if message_cutoff is not None:
            for model, field_name in MESSAGE_MODELS:
                try:
                    count = await archive_model_batches(
                        session, model, message_cutoff, current.cleanup_batch_size
                    )
                    setattr(summary, field_name, count)
                except Exception as exc:
                    await session.rollback()
                    summary.errors.append(f"{model.__tablename__}: {exc}")

        file_cutoff = attachment_cutoff(current, now)
        if file_cutoff is not None:
            for model in ATTACHMENT_MODELS:
                try:
                    deleted, missing = await cleanup_attachment_model_batches(
                        session, model, file_cutoff, current.cleanup_batch_size
                    )
                    summary.attachments_deleted += deleted
                    summary.files_missing += missing
                except Exception as exc:
                    await session.rollback()
                    summary.errors.append(f"{model.__tablename__}: {exc}")

        status = "completed_with_errors" if summary.errors else "completed"
        current = await get_retention_settings(session)
        current.last_cleanup_finished_at = datetime.now(timezone.utc)
        current.last_cleanup_status = status
        current.last_cleanup_summary = summary.model_dump()
        await record_retention_audit(
            session,
            "cleanup.finished",
            actor.id,
            {"status": status, "summary": summary.model_dump()},
        )
        await record_audit_event(
            session, event_type="retention.cleanup_completed", category="retention", action="cleanup",
            status="warning" if summary.errors else "success", actor=actor, target_type="retention_settings",
            target_id=str(current.id), target_label="retention",
            details={"status": status, "summary": summary.model_dump()}, request=request,
        )
        await session.commit()
        return RetentionRunResult(dry_run=False, status=status, summary=summary)


async def audit_dry_run(
    session: AsyncSession,
    current: RetentionSettings,
    actor: User,
    request: Request | None = None,
) -> RetentionRunResult:
    summary = await calculate_retention_summary(session, current)
    await record_retention_audit(
        session,
        "cleanup.dry_run",
        actor.id,
        {"settings": settings_snapshot(current), "summary": summary.model_dump()},
    )
    await record_audit_event(
        session, event_type="retention.dry_run", category="retention", action="dry_run", status="success",
        actor=actor, target_type="retention_settings", target_id=str(current.id), target_label="retention",
        details={"settings": settings_snapshot(current), "summary": summary.model_dump()}, request=request,
    )
    await session.commit()
    return RetentionRunResult(dry_run=True, status="preview", summary=summary)


def directory_size(root: Path) -> int:
    if not root.exists():
        return 0
    total = 0
    for path in root.rglob("*"):
        try:
            if path.is_file():
                total += path.stat().st_size
        except OSError:
            continue
    return total


async def attachment_storage_stats(session: AsyncSession, model: type[Any]) -> tuple[int, int, int]:
    total_bytes = 0
    count = 0
    missing = 0
    stream = await session.stream(select(model.storage_path, model.file_available))
    async for storage_path, file_available in stream:
        count += 1
        if not file_available:
            continue
        try:
            path = Path(storage_path)
            if path.exists() and path.is_file():
                total_bytes += path.stat().st_size
            else:
                missing += 1
        except OSError:
            missing += 1
    return total_bytes, count, missing


async def get_storage_stats(session: AsyncSession) -> StorageStats:
    group_stats = await attachment_storage_stats(session, MessageAttachment)
    direct_stats = await attachment_storage_stats(session, DirectMessageAttachment)
    discussion_stats = await attachment_storage_stats(session, DiscussionMessageAttachment)

    active = archived = soft_deleted = 0
    oldest_active: datetime | None = None
    oldest_archived: datetime | None = None
    for model, _ in MESSAGE_MODELS:
        active += await count_matching(
            session, model, model.is_archived.is_(False), model.is_deleted.is_(False)
        )
        archived += await count_matching(session, model, model.is_archived.is_(True))
        soft_deleted += await count_matching(session, model, model.is_deleted.is_(True))
        active_date = await session.scalar(
            select(func.min(model.created_at)).where(model.is_archived.is_(False))
        )
        archived_date = await session.scalar(
            select(func.min(model.created_at)).where(model.is_archived.is_(True))
        )
        if active_date is not None and (oldest_active is None or active_date < oldest_active):
            oldest_active = active_date
        if archived_date is not None and (oldest_archived is None or archived_date < oldest_archived):
            oldest_archived = archived_date

    uploads_root = Path(app_settings.uploads_dir)
    uploads_total, avatar_bytes = await asyncio.gather(
        asyncio.to_thread(directory_size, uploads_root),
        asyncio.to_thread(directory_size, uploads_root / "avatars"),
    )
    return StorageStats(
        uploads_total_bytes=uploads_total,
        avatar_bytes=avatar_bytes,
        group_attachment_bytes=group_stats[0],
        direct_attachment_bytes=direct_stats[0],
        discussion_attachment_bytes=discussion_stats[0],
        attachment_count=group_stats[1] + direct_stats[1] + discussion_stats[1],
        missing_file_count=group_stats[2] + direct_stats[2] + discussion_stats[2],
        message_counts=StorageMessageCounts(active=active, archived=archived, soft_deleted=soft_deleted),
        oldest_active_message_at=oldest_active,
        oldest_archived_message_at=oldest_archived,
    )
