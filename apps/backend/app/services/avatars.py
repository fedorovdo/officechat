import os
import uuid
from datetime import datetime, timezone
from pathlib import Path

from fastapi import UploadFile
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.models.user import User

ALLOWED_AVATAR_CONTENT_TYPES = {
    "png": "image/png",
    "jpg": "image/jpeg",
    "jpeg": "image/jpeg",
    "webp": "image/webp",
}


class AvatarValidationError(ValueError):
    def __init__(self, message: str, status_code: int = 400) -> None:
        super().__init__(message)
        self.status_code = status_code


def get_avatar_extension(upload: UploadFile) -> str:
    original_filename = Path(upload.filename or "").name.strip()
    if not original_filename:
        raise AvatarValidationError("Avatar file must have a filename")

    extension = Path(original_filename).suffix.lower().lstrip(".")
    if extension not in settings.allowed_avatar_extensions or extension not in ALLOWED_AVATAR_CONTENT_TYPES:
        allowed = ", ".join(settings.allowed_avatar_extensions)
        raise AvatarValidationError(f"Unsupported avatar image format. Allowed: {allowed}")

    expected_content_type = ALLOWED_AVATAR_CONTENT_TYPES[extension]
    if upload.content_type != expected_content_type:
        raise AvatarValidationError(f"Avatar content type must be {expected_content_type}")
    return extension


def validate_avatar_signature(data: bytes, extension: str) -> None:
    is_valid = False
    if extension == "png":
        is_valid = data.startswith(b"\x89PNG\r\n\x1a\n")
    elif extension in {"jpg", "jpeg"}:
        is_valid = data.startswith(b"\xff\xd8\xff")
    elif extension == "webp":
        is_valid = len(data) >= 12 and data.startswith(b"RIFF") and data[8:12] == b"WEBP"

    if not is_valid:
        raise AvatarValidationError("Uploaded file is not a valid supported image")


def avatar_relative_dir(user_id: uuid.UUID) -> Path:
    return Path("avatars") / "users" / str(user_id)


def resolve_avatar_path(avatar_path: str) -> Path:
    uploads_root = Path(settings.uploads_dir).resolve()
    resolved_path = (uploads_root / avatar_path).resolve()
    if os.path.commonpath([str(uploads_root), str(resolved_path)]) != str(uploads_root):
        raise AvatarValidationError("Avatar storage path is invalid")
    return resolved_path


async def update_user_avatar(session: AsyncSession, user: User, upload: UploadFile) -> User:
    extension = get_avatar_extension(upload)
    data = await upload.read(settings.avatar_max_upload_size_bytes + 1)
    if not data:
        raise AvatarValidationError("Avatar file cannot be empty")
    if len(data) > settings.avatar_max_upload_size_bytes:
        raise AvatarValidationError(
            f"Avatar file exceeds {settings.avatar_max_upload_size_mb} MB",
            status_code=413,
        )
    validate_avatar_signature(data, extension)

    uploads_root = Path(settings.uploads_dir).resolve()
    relative_dir = avatar_relative_dir(user.id)
    upload_dir = (uploads_root / relative_dir).resolve()
    upload_dir.mkdir(parents=True, exist_ok=True)
    stored_filename = f"{uuid.uuid4()}.{extension}"
    relative_path = relative_dir / stored_filename
    stored_path = resolve_avatar_path(str(relative_path))
    temporary_path = stored_path.with_suffix(f"{stored_path.suffix}.tmp")
    old_avatar_path = user.avatar_path

    try:
        temporary_path.write_bytes(data)
        temporary_path.replace(stored_path)
        user.avatar_path = relative_path.as_posix()
        user.avatar_content_type = ALLOWED_AVATAR_CONTENT_TYPES[extension]
        user.avatar_updated_at = datetime.now(timezone.utc)
        await session.commit()
        await session.refresh(user)
    except Exception:
        await session.rollback()
        temporary_path.unlink(missing_ok=True)
        stored_path.unlink(missing_ok=True)
        raise

    if old_avatar_path and old_avatar_path != user.avatar_path:
        try:
            resolve_avatar_path(old_avatar_path).unlink(missing_ok=True)
        except AvatarValidationError:
            pass
    return user


async def remove_user_avatar(session: AsyncSession, user: User) -> User:
    old_avatar_path = user.avatar_path
    user.avatar_path = None
    user.avatar_content_type = None
    user.avatar_updated_at = None
    await session.commit()
    await session.refresh(user)

    if old_avatar_path:
        try:
            resolve_avatar_path(old_avatar_path).unlink(missing_ok=True)
        except AvatarValidationError:
            pass
    return user
