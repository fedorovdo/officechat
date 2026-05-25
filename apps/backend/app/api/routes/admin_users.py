from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import get_db, require_admin_user
from app.models.user import User
from app.schemas.user import AdminUserCreate, UserPublic
from app.services.users import create_local_user, list_users

router = APIRouter(dependencies=[Depends(require_admin_user)])


@router.get("", response_model=list[UserPublic])
async def get_users(session: Annotated[AsyncSession, Depends(get_db)]) -> list[User]:
    return await list_users(session)


@router.post("", response_model=UserPublic, status_code=status.HTTP_201_CREATED)
async def create_user(
    payload: AdminUserCreate,
    session: Annotated[AsyncSession, Depends(get_db)],
) -> User:
    try:
        return await create_local_user(session, payload)
    except IntegrityError as exc:
        await session.rollback()
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="Username or email already exists",
        ) from exc
