from typing import Annotated

import jwt
from fastapi import Depends, HTTPException, Request, status
from fastapi.security import OAuth2PasswordBearer
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.session import get_db_session
from app.models.user import User
from app.services.security import decode_access_token
from app.services.audit import record_audit_event_best_effort, should_record_security_event, token_fingerprint
from app.services.permissions import require_permission
from app.services.users import get_user_by_id
from app.core.permissions import CAN_BROADCAST, CAN_PIN_MESSAGES

oauth2_scheme = OAuth2PasswordBearer(tokenUrl="/api/auth/login")
AdminRoles = {"superadmin", "admin"}


async def get_db(
    session: Annotated[AsyncSession, Depends(get_db_session)],
) -> AsyncSession:
    return session


async def get_current_user(
    request: Request,
    token: Annotated[str, Depends(oauth2_scheme)],
    session: Annotated[AsyncSession, Depends(get_db)],
) -> User:
    credentials_error = HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail="Could not validate credentials",
        headers={"WWW-Authenticate": "Bearer"},
    )

    try:
        payload = decode_access_token(token)
        user_id = payload.get("sub")
    except jwt.PyJWTError as exc:
        fingerprint = token_fingerprint(token)
        source_ip = request.client.host if request.client else "unknown"
        if should_record_security_event(f"invalid-token:{source_ip}:{fingerprint}"):
            expired = isinstance(exc, jwt.ExpiredSignatureError)
            await record_audit_event_best_effort(
                event_type="auth.session.expired" if expired else "security.invalid_token",
                category="authentication" if expired else "security", action="authenticate", status="denied",
                details={"token_fingerprint": fingerprint},
                error_code="expired_token" if expired else "invalid_token", request=request,
            )
        raise credentials_error from exc

    if not isinstance(user_id, str):
        raise credentials_error

    user = await get_user_by_id(session, user_id)
    if user is None or not user.is_active:
        raise credentials_error
    return user


async def require_admin_user(
    request: Request,
    current_user: Annotated[User, Depends(get_current_user)],
) -> User:
    if current_user.role not in AdminRoles:
        if should_record_security_event(f"admin-denied:{current_user.id}:{request.url.path}"):
            await record_audit_event_best_effort(
                event_type="security.access_denied", category="security", action="admin_access", status="denied",
                actor=current_user, target_type="endpoint", target_label=request.url.path,
                details={"method": request.method}, error_code="admin_role_required", request=request,
            )
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Admin role required")
    return current_user


async def require_can_broadcast(
    session: Annotated[AsyncSession, Depends(get_db)],
    current_user: Annotated[User, Depends(get_current_user)],
) -> User:
    await require_permission(session, current_user, CAN_BROADCAST)
    return current_user


async def require_can_pin_messages(
    session: Annotated[AsyncSession, Depends(get_db)],
    current_user: Annotated[User, Depends(get_current_user)],
) -> User:
    await require_permission(session, current_user, CAN_PIN_MESSAGES)
    return current_user
