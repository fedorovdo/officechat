import logging
import os
import uuid
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Literal
from uuid import UUID

from fastapi import UploadFile
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.core.config import BLOCKED_UPLOAD_EXTENSIONS, settings
from app.models.attachment import MessageAttachment
from app.models.group import Group
from app.models.message import Message
from app.models.user import User
from app.services.mentions import sync_message_mentions
from app.services.messages import load_message_with_sender

logger = logging.getLogger(__name__)

UPLOAD_CHUNK_SIZE = 1024 * 1024
AttachmentStorageKind = Literal["group", "direct", "discussion"]
GENERIC_CONTENT_TYPES = {"", "application/octet-stream"}
ATTACHMENT_CONTENT_TYPES: dict[str, tuple[str, ...]] = {
    "txt": ("text/plain",),
    "log": ("text/plain",),
    "csv": ("text/csv", "application/csv"),
    "md": ("text/markdown", "text/plain"),
    "json": ("application/json", "text/json"),
    "xml": ("application/xml", "text/xml"),
    "yaml": ("application/yaml", "application/x-yaml", "text/yaml", "text/x-yaml", "text/plain"),
    "yml": ("application/yaml", "application/x-yaml", "text/yaml", "text/x-yaml", "text/plain"),
    "ini": ("text/plain",),
    "conf": ("text/plain",),
    "pdf": ("application/pdf",),
    "doc": ("application/msword",),
    "docx": ("application/vnd.openxmlformats-officedocument.wordprocessingml.document",),
    "xls": ("application/vnd.ms-excel",),
    "xlsx": ("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",),
    "png": ("image/png",),
    "jpg": ("image/jpeg",),
    "jpeg": ("image/jpeg",),
    "webp": ("image/webp",),
    "zip": ("application/zip", "application/x-zip-compressed"),
}


@dataclass(frozen=True)
class SavedUpload:
    original_filename: str
    stored_filename: str
    storage_path: str
    content_type: str | None
    size_bytes: int


def normalize_original_filename(filename: str | None) -> str:
    original_filename = Path((filename or "").replace("\\", "/")).name.strip()
    if not original_filename:
        raise ValueError("Uploaded file must have a filename")
    return original_filename[:255]


def validate_file_extension(original_filename: str) -> str:
    extension = Path(original_filename).suffix.lower().lstrip(".")
    if not extension or extension in BLOCKED_UPLOAD_EXTENSIONS or extension not in settings.allowed_upload_extensions:
        extension_label = f".{extension}" if extension else "missing extension"
        raise ValueError(f"File type is not allowed: {extension_label}")
    return extension


def normalize_content_type(extension: str, content_type: str | None) -> str:
    normalized_content_type = (content_type or "").split(";", 1)[0].strip().lower()
    allowed_content_types = ATTACHMENT_CONTENT_TYPES.get(extension, ())
    if normalized_content_type in GENERIC_CONTENT_TYPES:
        return allowed_content_types[0] if allowed_content_types else "application/octet-stream"
    return normalized_content_type


def validate_upload(upload: UploadFile) -> tuple[str, str, str]:
    original_filename = normalize_original_filename(upload.filename)
    extension = validate_file_extension(original_filename)
    return original_filename, extension, normalize_content_type(extension, upload.content_type)


def safe_filename(extension: str) -> str:
    return f"{uuid.uuid4()}.{extension}"


def build_storage_subdir(storage_kind: AttachmentStorageKind, owner_id: UUID) -> Path:
    today = datetime.now(timezone.utc)
    root = Path(settings.uploads_dir)
    if storage_kind == "group":
        root = root / "groups" / str(owner_id)
    elif storage_kind == "direct":
        root = root / "direct" / str(owner_id)
    else:
        root = root / "discussions" / str(owner_id)
    return root / f"{today:%Y}" / f"{today:%m}" / f"{today:%d}"


async def save_uploads(
    storage_kind: AttachmentStorageKind,
    owner_id: UUID,
    uploads: list[UploadFile],
) -> list[SavedUpload]:
    if not uploads:
        raise ValueError("At least one attachment is required")
    if len(uploads) > settings.attachment_max_files_per_message:
        raise ValueError(
            f"A message can contain at most {settings.attachment_max_files_per_message} attachments"
        )

    # Validate every filename and extension before writing any request data.
    validated_uploads = [(upload, *validate_upload(upload)) for upload in uploads]
    upload_dir = build_storage_subdir(storage_kind, owner_id)
    upload_dir.mkdir(parents=True, exist_ok=True)
    saved_uploads: list[SavedUpload] = []
    total_size_bytes = 0

    try:
        for upload, original_filename, extension, content_type in validated_uploads:
            stored_filename = safe_filename(extension)
            storage_path = upload_dir / stored_filename
            size_bytes = 0

            try:
                with storage_path.open("wb") as destination:
                    while chunk := await upload.read(UPLOAD_CHUNK_SIZE):
                        size_bytes += len(chunk)
                        total_size_bytes += len(chunk)
                        if size_bytes > settings.max_upload_size_bytes:
                            raise ValueError(
                                f"Uploaded file exceeds {settings.attachment_max_upload_size_mb} MB"
                            )
                        if total_size_bytes > settings.attachment_max_total_size_bytes:
                            raise ValueError(
                                "Total attachment size exceeds "
                                f"{settings.attachment_max_total_size_mb} MB"
                            )
                        destination.write(chunk)
            except BaseException:
                storage_path.unlink(missing_ok=True)
                raise

            if size_bytes == 0:
                storage_path.unlink(missing_ok=True)
                raise ValueError("Uploaded file cannot be empty")

            saved_uploads.append(
                SavedUpload(
                    original_filename=original_filename,
                    stored_filename=stored_filename,
                    storage_path=str(storage_path),
                    content_type=content_type,
                    size_bytes=size_bytes,
                )
            )
        return saved_uploads
    except BaseException:
        for saved_upload in saved_uploads:
            remove_saved_file(saved_upload.storage_path)
        raise


async def save_upload(storage_kind: AttachmentStorageKind, owner_id: UUID, upload: UploadFile) -> SavedUpload:
    return (await save_uploads(storage_kind, owner_id, [upload]))[0]


def remove_saved_file(storage_path: str) -> None:
    Path(storage_path).unlink(missing_ok=True)


def mark_attachments_unavailable(attachments: list[object], deleted_at: datetime | None = None) -> None:
    unavailable_at = deleted_at or datetime.now(timezone.utc)
    for attachment in attachments:
        setattr(attachment, "file_available", False)
        setattr(attachment, "file_deleted_at", unavailable_at)


def delete_attachment_files_best_effort(attachments: list[object]) -> tuple[int, int]:
    deleted = 0
    errors = 0
    for attachment in attachments:
        try:
            path = resolve_attachment_path(attachment)
            if path.exists() and path.is_file():
                remove_saved_file(str(path))
                deleted += 1
        except (OSError, ValueError) as exc:
            errors += 1
            logger.warning(
                "Attachment cleanup failed for attachment_id=%s: %s",
                getattr(attachment, "id", "unknown"),
                type(exc).__name__,
            )
    return deleted, errors


def validate_attachment_message_body(body: str | None) -> str:
    normalized_body = body.strip() if body else ""
    if len(normalized_body) > settings.message_max_length:
        raise ValueError(f"Message body cannot exceed {settings.message_max_length} characters")
    return normalized_body


def resolve_attachment_path(attachment: object) -> Path:
    uploads_root = Path(settings.uploads_dir).resolve()
    attachment_path = Path(str(getattr(attachment, "storage_path"))).resolve()
    if os.path.commonpath([uploads_root, attachment_path]) != str(uploads_root):
        raise ValueError("Attachment storage path is invalid")
    return attachment_path


async def create_message_with_attachments(
    session: AsyncSession,
    group: Group,
    current_user: User,
    body: str | None,
    uploads: list[UploadFile],
    reply_to_message_id: UUID | None = None,
) -> Message:
    normalized_body = validate_attachment_message_body(body)
    if not normalized_body and not uploads:
        raise ValueError("Message body or at least one attachment is required")
    saved_uploads = await save_uploads("group", group.id, uploads) if uploads else []

    try:
        normalized_reply_to_message_id = None
        if reply_to_message_id is not None:
            reply_to_message = await load_reply_target(session, group, reply_to_message_id)
            normalized_reply_to_message_id = reply_to_message.id

        message = Message(
            group_id=group.id,
            sender_user_id=current_user.id,
            reply_to_message_id=normalized_reply_to_message_id,
            body=normalized_body,
            message_type="text",
        )
        session.add(message)
        await session.flush()

        session.add_all(
            [MessageAttachment(
                message_id=message.id,
                group_id=group.id,
                uploaded_by_user_id=current_user.id,
                original_filename=saved_upload.original_filename,
                stored_filename=saved_upload.stored_filename,
                storage_path=saved_upload.storage_path,
                content_type=saved_upload.content_type,
                size_bytes=saved_upload.size_bytes,
                sort_order=sort_order,
            ) for sort_order, saved_upload in enumerate(saved_uploads)]
        )
        await sync_message_mentions(session, message)
        await session.commit()
    except BaseException:
        await session.rollback()
        for saved_upload in saved_uploads:
            remove_saved_file(saved_upload.storage_path)
        raise

    return await load_message_with_sender(session, message.id)


async def create_message_with_attachment(
    session: AsyncSession,
    group: Group,
    current_user: User,
    body: str | None,
    upload: UploadFile,
    reply_to_message_id: UUID | None = None,
) -> Message:
    return await create_message_with_attachments(
        session, group, current_user, body, [upload], reply_to_message_id
    )


async def load_reply_target(session: AsyncSession, group: Group, reply_to_message_id: UUID) -> Message:
    result = await session.execute(
        select(Message).where(Message.id == reply_to_message_id, Message.group_id == group.id)
    )
    message = result.scalar_one_or_none()
    if message is None:
        raise ValueError("Reply target message not found in this group")
    if message.is_archived:
        raise ValueError("Archived messages cannot receive new replies")
    return message


async def get_group_attachment(
    session: AsyncSession,
    group: Group,
    attachment_id: UUID,
) -> MessageAttachment | None:
    result = await session.execute(
        select(MessageAttachment)
        .options(selectinload(MessageAttachment.message))
        .where(
            MessageAttachment.id == attachment_id,
            MessageAttachment.group_id == group.id,
        )
    )
    return result.scalar_one_or_none()
