from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Request, status
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import get_db, get_current_user
from app.models.user import User
from app.schemas.permission import PermissionPublic, UserPermissionState, UserPermissionsUpdate
from app.services.permissions import (
    PermissionValidationError,
    broadcast_permissions_updated,
    get_user_permission_state,
    list_permission_catalog,
    replace_user_permissions,
)
from app.services.users import get_user_by_id

router = APIRouter()


def require_superadmin(current_user: User) -> None:
    if current_user.role != "superadmin":
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Only superadmin can manage permissions")


@router.get("/permissions", response_model=list[PermissionPublic])
async def get_permissions(
    session: Annotated[AsyncSession, Depends(get_db)],
    current_user: Annotated[User, Depends(get_current_user)],
) -> list:
    require_superadmin(current_user)
    return await list_permission_catalog(session)


@router.get("/users/{user_id}/permissions", response_model=UserPermissionState)
async def get_user_permissions(
    user_id: UUID,
    session: Annotated[AsyncSession, Depends(get_db)],
    current_user: Annotated[User, Depends(get_current_user)],
) -> UserPermissionState:
    require_superadmin(current_user)
    target_user = await get_user_by_id(session, user_id)
    if target_user is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="User not found")
    return await get_user_permission_state(session, target_user)


@router.put("/users/{user_id}/permissions", response_model=UserPermissionState)
async def put_user_permissions(
    user_id: UUID,
    payload: UserPermissionsUpdate,
    request: Request,
    session: Annotated[AsyncSession, Depends(get_db)],
    current_user: Annotated[User, Depends(get_current_user)],
) -> UserPermissionState:
    require_superadmin(current_user)
    target_user = await get_user_by_id(session, user_id)
    if target_user is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="User not found")
    try:
        state = await replace_user_permissions(
            session,
            actor=current_user,
            target_user=target_user,
            permission_keys=payload.permissions,
            request=request,
        )
        await session.commit()
        await broadcast_permissions_updated(session, target_user)
        return state
    except PermissionValidationError as exc:
        await session.rollback()
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)) from exc
    except Exception:
        await session.rollback()
        raise
