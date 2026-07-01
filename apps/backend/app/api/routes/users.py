from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, status
from fastapi.responses import FileResponse
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import get_current_user, get_db
from app.models.user import User
from app.schemas.user import UserDirectoryEntry
from app.services.avatars import AvatarValidationError, resolve_avatar_path
from app.services.users import get_user_by_id, list_active_users

router = APIRouter()


@router.get("", response_model=list[UserDirectoryEntry])
async def get_users_directory(
    session: Annotated[AsyncSession, Depends(get_db)],
    _: Annotated[User, Depends(get_current_user)],
) -> list[User]:
    return await list_active_users(session)


@router.get("/{user_id}/avatar", response_class=FileResponse)
async def get_user_avatar(
    user_id: UUID,
    session: Annotated[AsyncSession, Depends(get_db)],
    _: Annotated[User, Depends(get_current_user)],
) -> FileResponse:
    user = await get_user_by_id(session, user_id)
    if user is None or not user.avatar_path or not user.avatar_content_type:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Avatar not found")

    try:
        avatar_path = resolve_avatar_path(user.avatar_path)
    except AvatarValidationError as exc:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Avatar not found") from exc
    if not avatar_path.is_file():
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Avatar not found")

    return FileResponse(
        path=avatar_path,
        media_type=user.avatar_content_type,
        headers={
            "Cache-Control": "private, max-age=3600",
            "X-Content-Type-Options": "nosniff",
        },
    )
