from typing import Annotated

import jwt
from fastapi import Depends, HTTPException, status
from fastapi.security import OAuth2PasswordBearer
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.session import get_db_session
from app.models.user import User
from app.services.security import decode_access_token
from app.services.users import get_user_by_id

oauth2_scheme = OAuth2PasswordBearer(tokenUrl="/api/auth/login")
AdminRoles = {"superadmin", "admin"}


async def get_db(
    session: Annotated[AsyncSession, Depends(get_db_session)],
) -> AsyncSession:
    return session


async def get_current_user(
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
        raise credentials_error from exc

    if not isinstance(user_id, str):
        raise credentials_error

    user = await get_user_by_id(session, user_id)
    if user is None or not user.is_active:
        raise credentials_error
    return user


async def require_admin_user(
    current_user: Annotated[User, Depends(get_current_user)],
) -> User:
    if current_user.role not in AdminRoles:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Admin role required")
    return current_user
