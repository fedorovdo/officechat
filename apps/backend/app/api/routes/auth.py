from typing import Annotated

from fastapi import APIRouter, Depends, File, HTTPException, Request, UploadFile, status
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import get_current_user, get_db
from app.models.user import User
from app.schemas.auth import LoginRequest, LogoutResponse, TokenResponse
from app.schemas.user import UserProfileUpdate, UserPublic
from app.services.avatars import AvatarValidationError, remove_user_avatar, update_user_avatar
from app.services.audit import record_audit_event, record_audit_event_best_effort
from app.services.permissions import get_effective_permission_keys
from app.services.security import create_access_token
from app.services.users import authenticate_user, update_user_profile

router = APIRouter()


async def user_public_with_permissions(session: AsyncSession, user: User) -> UserPublic:
    return UserPublic.model_validate(user).model_copy(
        update={"permissions": await get_effective_permission_keys(session, user)}
    )


@router.post("/login", response_model=TokenResponse)
async def login(payload: LoginRequest, request: Request, session: Annotated[AsyncSession, Depends(get_db)]) -> TokenResponse:
    user = await authenticate_user(session, payload.username, payload.password, commit=False)
    if user is None:
        await record_audit_event_best_effort(
            event_type="auth.login.failed", category="authentication", action="login", status="failure",
            actor_username=payload.username.strip(), target_type="user", target_label=payload.username.strip(),
            details={"reason": "invalid_credentials"}, error_code="invalid_credentials", request=request,
        )
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid username or password",
            headers={"WWW-Authenticate": "Bearer"},
        )

    await record_audit_event(
        session, event_type="auth.login.succeeded", category="authentication", action="login", status="success",
        actor=user, target_type="user", target_id=user.id, target_label=user.username, request=request,
    )
    await session.commit()
    await session.refresh(user)
    token = create_access_token(user.id, user.username, user.role)
    return TokenResponse(access_token=token, user=await user_public_with_permissions(session, user))


@router.get("/me", response_model=UserPublic)
async def me(
    session: Annotated[AsyncSession, Depends(get_db)],
    current_user: Annotated[User, Depends(get_current_user)],
) -> UserPublic:
    return await user_public_with_permissions(session, current_user)


@router.patch("/me", response_model=UserPublic)
async def patch_me(
    payload: UserProfileUpdate,
    request: Request,
    session: Annotated[AsyncSession, Depends(get_db)],
    current_user: Annotated[User, Depends(get_current_user)],
) -> UserPublic:
    old_name = current_user.display_name
    updated = await update_user_profile(session, current_user, payload, commit=False)
    await record_audit_event(
        session, event_type="user.profile_updated", category="profile", action="update", status="success",
        actor=current_user, target_type="user", target_id=current_user.id, target_label=current_user.username,
        details={"changes": {"display_name": {"old": old_name, "new": updated.display_name}}}, request=request,
    )
    await session.commit()
    await session.refresh(updated)
    return await user_public_with_permissions(session, updated)


@router.post("/me/avatar", response_model=UserPublic)
async def upload_my_avatar(
    request: Request,
    file: Annotated[UploadFile, File()],
    session: Annotated[AsyncSession, Depends(get_db)],
    current_user: Annotated[User, Depends(get_current_user)],
) -> UserPublic:
    replaced_existing = current_user.avatar_path is not None
    try:
        updated = await update_user_avatar(session, current_user, file)
        await record_audit_event(
            session, event_type="user.avatar_uploaded", category="profile", action="upload_avatar", status="success",
            actor=current_user, target_type="user", target_id=current_user.id, target_label=current_user.username,
            details={"content_type": updated.avatar_content_type, "size": file.size, "replaced_existing": replaced_existing},
            request=request,
        )
        await session.commit()
        return await user_public_with_permissions(session, updated)
    except AvatarValidationError as exc:
        await record_audit_event_best_effort(
            event_type="security.upload_rejected", category="security", action="upload_avatar", status="failure",
            actor=current_user, target_type="user", target_id=current_user.id, target_label=current_user.username,
            details={"content_type": file.content_type, "size": file.size},
            error_code="avatar_validation_failed", error_message=str(exc), request=request,
        )
        raise HTTPException(status_code=exc.status_code, detail=str(exc)) from exc
    finally:
        await file.close()


@router.delete("/me/avatar", response_model=UserPublic)
async def delete_my_avatar(
    request: Request,
    session: Annotated[AsyncSession, Depends(get_db)],
    current_user: Annotated[User, Depends(get_current_user)],
) -> UserPublic:
    updated = await remove_user_avatar(session, current_user)
    await record_audit_event(
        session, event_type="user.avatar_removed", category="profile", action="remove_avatar", status="success",
        actor=current_user, target_type="user", target_id=current_user.id, target_label=current_user.username,
        details={"removed_existing": True}, request=request,
    )
    await session.commit()
    return await user_public_with_permissions(session, updated)


@router.post("/logout", response_model=LogoutResponse)
async def logout(
    request: Request,
    session: Annotated[AsyncSession, Depends(get_db)],
    current_user: Annotated[User, Depends(get_current_user)],
) -> LogoutResponse:
    await record_audit_event(
        session, event_type="auth.logout", category="authentication", action="logout", status="success",
        actor=current_user, target_type="user", target_id=current_user.id, target_label=current_user.username,
        request=request,
    )
    await session.commit()
    return LogoutResponse()
