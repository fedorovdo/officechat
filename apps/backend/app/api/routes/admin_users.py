from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import get_db, require_admin_user
from app.models.user import User
from app.schemas.user import AdminPasswordReset, AdminUserCreate, AdminUserUpdate, UserPublic
from app.services.users import (
    create_local_user,
    get_user_by_id,
    list_users,
    reset_local_user_password,
    update_user,
)

router = APIRouter()


@router.get("", response_model=list[UserPublic])
async def get_users(
    session: Annotated[AsyncSession, Depends(get_db)],
    _: Annotated[User, Depends(require_admin_user)],
) -> list[User]:
    return await list_users(session)


@router.post("", response_model=UserPublic, status_code=status.HTTP_201_CREATED)
async def create_user(
    payload: AdminUserCreate,
    session: Annotated[AsyncSession, Depends(get_db)],
    current_user: Annotated[User, Depends(require_admin_user)],
) -> User:
    if current_user.role != "superadmin" and payload.role == "superadmin":
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Only superadmin can create superadmin users",
        )

    try:
        return await create_local_user(session, payload)
    except IntegrityError as exc:
        await session.rollback()
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="Username or email already exists",
        ) from exc


@router.patch("/{user_id}", response_model=UserPublic)
async def patch_user(
    user_id: UUID,
    payload: AdminUserUpdate,
    session: Annotated[AsyncSession, Depends(get_db)],
    current_user: Annotated[User, Depends(require_admin_user)],
) -> User:
    target_user = await get_user_by_id(session, user_id)
    if target_user is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="User not found")

    if current_user.role != "superadmin" and target_user.role == "superadmin":
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Admin cannot edit superadmin users",
        )

    if current_user.role != "superadmin" and payload.role == "superadmin":
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Only superadmin can promote users to superadmin",
        )

    if (
        current_user.role == "superadmin"
        and current_user.id == target_user.id
        and payload.is_active is False
    ):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Superadmin cannot disable their own account",
        )

    try:
        return await update_user(session, target_user, payload)
    except IntegrityError as exc:
        await session.rollback()
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="Email already exists",
        ) from exc


@router.post("/{user_id}/reset-password", response_model=UserPublic)
async def reset_password(
    user_id: UUID,
    payload: AdminPasswordReset,
    session: Annotated[AsyncSession, Depends(get_db)],
    current_user: Annotated[User, Depends(require_admin_user)],
) -> User:
    target_user = await get_user_by_id(session, user_id)
    if target_user is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="User not found")

    if target_user.auth_provider != "local":
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Password reset is only available for local users",
        )

    if current_user.role != "superadmin" and target_user.role == "superadmin":
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Admin cannot reset superadmin passwords",
        )

    return await reset_local_user_password(session, target_user, payload)
