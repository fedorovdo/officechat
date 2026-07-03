from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Request, status
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import get_db, require_admin_user
from app.models.user import User
from app.schemas.user import AdminPasswordReset, AdminUserCreate, AdminUserUpdate, UserPublic
from app.services.audit import record_audit_event
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
    request: Request,
    session: Annotated[AsyncSession, Depends(get_db)],
    current_user: Annotated[User, Depends(require_admin_user)],
) -> User:
    if current_user.role != "superadmin" and payload.role == "superadmin":
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Only superadmin can create superadmin users",
        )

    try:
        user = await create_local_user(session, payload, commit=False)
        await record_audit_event(
            session, event_type="user.created", category="users", action="create", status="success",
            actor=current_user, target_type="user", target_id=user.id, target_label=user.username,
            details={"role": user.role, "is_active": user.is_active, "auth_provider": user.auth_provider}, request=request,
        )
        await session.commit()
        await session.refresh(user)
        return user
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
    request: Request,
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

    if current_user.id == target_user.id and payload.is_active is False:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Users cannot disable their own account",
        )

    before = {field: getattr(target_user, field) for field in ("display_name", "email", "role", "is_active")}
    try:
        updated = await update_user(session, target_user, payload, commit=False)
        changes = {
            field: {"old": before[field], "new": getattr(updated, field)}
            for field in before
            if before[field] != getattr(updated, field)
        }
        await record_audit_event(
            session, event_type="user.updated", category="users", action="update", status="success",
            actor=current_user, target_type="user", target_id=updated.id, target_label=updated.username,
            details={"changes": changes}, request=request,
        )
        if "role" in changes:
            await record_audit_event(
                session, event_type="user.role_changed", category="users", action="change_role", status="success",
                actor=current_user, target_type="user", target_id=updated.id, target_label=updated.username,
                details={"changes": {"role": changes["role"]}}, request=request,
            )
        if "is_active" in changes:
            await record_audit_event(
                session, event_type="user.enabled" if updated.is_active else "user.disabled", category="users",
                action="enable" if updated.is_active else "disable", status="success", actor=current_user,
                target_type="user", target_id=updated.id, target_label=updated.username,
                details={"changes": {"is_active": changes["is_active"]}}, request=request,
            )
        await session.commit()
        await session.refresh(updated)
        return updated
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
    request: Request,
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

    updated = await reset_local_user_password(session, target_user, payload, commit=False)
    await record_audit_event(
        session, event_type="user.password_reset", category="users", action="reset_password", status="success",
        actor=current_user, target_type="user", target_id=updated.id, target_label=updated.username,
        details={"password_reset": True}, request=request,
    )
    await session.commit()
    await session.refresh(updated)
    return updated
