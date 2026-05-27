from typing import Annotated

from fastapi import APIRouter, Depends
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import get_current_user, get_db
from app.models.user import User
from app.schemas.user import UserDirectoryEntry
from app.services.users import list_active_users

router = APIRouter()


@router.get("", response_model=list[UserDirectoryEntry])
async def get_users_directory(
    session: Annotated[AsyncSession, Depends(get_db)],
    _: Annotated[User, Depends(get_current_user)],
) -> list[User]:
    return await list_active_users(session)
