from dataclasses import asdict, dataclass
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.attachment import (
    DirectMessageAttachment,
    DiscussionMessageAttachment,
    MessageAttachment,
)
from app.models.direct import DirectMessage
from app.models.discussion import DiscussionMessage
from app.models.message import Message
from app.services.attachments import (
    delete_attachment_files_best_effort,
    mark_attachments_unavailable,
    resolve_attachment_path,
)

ATTACHMENT_PARENT_MODELS = (
    (MessageAttachment, Message, MessageAttachment.message_id),
    (DirectMessageAttachment, DirectMessage, DirectMessageAttachment.direct_message_id),
    (
        DiscussionMessageAttachment,
        DiscussionMessage,
        DiscussionMessageAttachment.discussion_message_id,
    ),
)


@dataclass(slots=True)
class DeletedAttachmentCleanupReport:
    records: int = 0
    records_to_disable: int = 0
    files_found: int = 0
    size_bytes: int = 0
    files_deleted: int = 0
    files_missing: int = 0
    errors: int = 0
    applied: bool = False

    def as_dict(self) -> dict[str, int | bool]:
        return asdict(self)


def deleted_attachment_query(attachment_model: type[Any], parent_model: type[Any], parent_fk: Any):
    return (
        select(attachment_model)
        .join(parent_model, parent_model.id == parent_fk)
        .where(parent_model.is_deleted.is_(True))
        .order_by(attachment_model.created_at.asc(), attachment_model.id.asc())
    )


async def list_deleted_message_attachments(session: AsyncSession) -> list[object]:
    rows: list[object] = []
    for attachment_model, parent_model, parent_fk in ATTACHMENT_PARENT_MODELS:
        result = await session.execute(
            deleted_attachment_query(attachment_model, parent_model, parent_fk)
        )
        rows.extend(result.scalars().all())
    return rows


async def cleanup_deleted_message_attachments(
    session: AsyncSession,
    *,
    apply: bool = False,
) -> DeletedAttachmentCleanupReport:
    attachments = await list_deleted_message_attachments(session)
    report = DeletedAttachmentCleanupReport(applied=apply)
    candidates: list[object] = []
    attachments_to_disable: list[object] = []

    for attachment in attachments:
        file_available = bool(getattr(attachment, "file_available", False))
        try:
            path = resolve_attachment_path(attachment)
            file_exists = path.exists() and path.is_file()
            if not file_available and not file_exists:
                continue

            candidates.append(attachment)
            report.records += 1
            if file_available:
                attachments_to_disable.append(attachment)
                report.records_to_disable += 1
            if file_exists:
                report.files_found += 1
                report.size_bytes += int(getattr(attachment, "size_bytes", 0) or 0)
            elif file_available:
                report.files_missing += 1
        except (OSError, ValueError):
            report.errors += 1
            if file_available:
                candidates.append(attachment)
                attachments_to_disable.append(attachment)
                report.records += 1
                report.records_to_disable += 1

    if not apply:
        return report

    if report.records_to_disable:
        mark_attachments_unavailable(attachments_to_disable)
        try:
            await session.commit()
        except BaseException:
            await session.rollback()
            raise
    report.files_deleted, unlink_errors = delete_attachment_files_best_effort(candidates)
    report.errors += unlink_errors
    return report
