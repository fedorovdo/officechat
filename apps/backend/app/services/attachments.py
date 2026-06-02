import os
import uuid
from datetime import datetime, timezone
from pathlib import Path
from uuid import UUID

from fastapi import UploadFile
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.core.config import settings
from app.models.attachment import MessageAttachment
from app.models.group import Group
from app.models.message import Message
from app.models.user import User
from app.services.mentions import sync_message_mentions
from app.services.messages import load_message_with_sender

UPLOAD_CHUNK_SIZE = 1024 * 1024


def normalize_original_filename(filename: str | None) -> str:
    original_filename = Path(filename or "").name.strip()
    if not original_filename:
        raise ValueError("Uploaded file must have a filename")
    return original_filename[:255]


def validate_file_extension(original_filename: str) -> str:
    extension = Path(original_filename).suffix.lower().lstrip(".")
    if not extension:
        raise ValueError("Uploaded file must have an allowed extension")
    if extension not in settings.allowed_upload_extensions:
        allowed_extensions = ", ".join(settings.allowed_upload_extensions)
        raise ValueError(f"File extension .{extension} is not allowed. Allowed: {allowed_extensions}")
    return extension


def build_group_upload_dir(group_id: UUID) -> Path:
    today = datetime.now(timezone.utc)
    return Path(settings.uploads_dir) / str(group_id) / f"{today:%Y}" / f"{today:%m}" / f"{today:%d}"


async def save_upload_file(group: Group, upload: UploadFile) -> tuple[str, str, int]:
    original_filename = normalize_original_filename(upload.filename)
    extension = validate_file_extension(original_filename)
    upload_dir = build_group_upload_dir(group.id)
    upload_dir.mkdir(parents=True, exist_ok=True)

    stored_filename = f"{uuid.uuid4()}.{extension}"
    storage_path = upload_dir / stored_filename
    size_bytes = 0

    with storage_path.open("wb") as destination:
        while chunk := await upload.read(UPLOAD_CHUNK_SIZE):
            size_bytes += len(chunk)
            if size_bytes > settings.max_upload_size_bytes:
                destination.close()
                storage_path.unlink(missing_ok=True)
                raise ValueError(f"Uploaded file exceeds {settings.max_upload_size_mb} MB")
            destination.write(chunk)

    if size_bytes == 0:
        storage_path.unlink(missing_ok=True)
        raise ValueError("Uploaded file cannot be empty")

    return stored_filename, str(storage_path), size_bytes


def resolve_attachment_path(attachment: MessageAttachment) -> Path:
    uploads_root = Path(settings.uploads_dir).resolve()
    attachment_path = Path(attachment.storage_path).resolve()
    if os.path.commonpath([uploads_root, attachment_path]) != str(uploads_root):
        raise ValueError("Attachment storage path is invalid")
    return attachment_path


async def create_message_with_attachment(
    session: AsyncSession,
    group: Group,
    current_user: User,
    body: str | None,
    upload: UploadFile,
    reply_to_message_id: UUID | None = None,
) -> Message:
    stored_filename, storage_path, size_bytes = await save_upload_file(group, upload)
    original_filename = normalize_original_filename(upload.filename)
    normalized_body = body.strip() if body else ""
    if len(normalized_body) > settings.message_max_length:
        Path(storage_path).unlink(missing_ok=True)
        raise ValueError(f"Message body cannot exceed {settings.message_max_length} characters")

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

        session.add(
            MessageAttachment(
                message_id=message.id,
                group_id=group.id,
                uploaded_by_user_id=current_user.id,
                original_filename=original_filename,
                stored_filename=stored_filename,
                storage_path=storage_path,
                content_type=upload.content_type,
                size_bytes=size_bytes,
            )
        )
        await sync_message_mentions(session, message)
        await session.commit()
    except Exception:
        await session.rollback()
        Path(storage_path).unlink(missing_ok=True)
        raise

    return await load_message_with_sender(session, message.id)


async def load_reply_target(session: AsyncSession, group: Group, reply_to_message_id: UUID) -> Message:
    result = await session.execute(
        select(Message).where(Message.id == reply_to_message_id, Message.group_id == group.id)
    )
    message = result.scalar_one_or_none()
    if message is None:
        raise ValueError("Reply target message not found in this group")
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
