from datetime import datetime, timezone
from uuid import UUID

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.user import User
from app.schemas.user import AdminPasswordReset, AdminUserCreate, AdminUserUpdate
from app.services.security import hash_password, verify_password


def normalize_username(username: str) -> str:
    return username.strip().lower()


async def count_users(session: AsyncSession) -> int:
    result = await session.execute(select(func.count(User.id)))
    return int(result.scalar_one())


async def get_user_by_username(session: AsyncSession, username: str) -> User | None:
    result = await session.execute(select(User).where(User.username == normalize_username(username)))
    return result.scalar_one_or_none()


async def get_user_by_id(session: AsyncSession, user_id: str | UUID) -> User | None:
    parsed_user_id = user_id if isinstance(user_id, UUID) else UUID(user_id)
    result = await session.execute(select(User).where(User.id == parsed_user_id))
    return result.scalar_one_or_none()


async def authenticate_user(session: AsyncSession, username: str, password: str) -> User | None:
    user = await get_user_by_username(session, username)
    if not user or not user.is_active or not verify_password(password, user.password_hash):
        return None

    user.last_login_at = datetime.now(timezone.utc)
    await session.commit()
    await session.refresh(user)
    return user


async def list_users(session: AsyncSession) -> list[User]:
    result = await session.execute(select(User).order_by(User.created_at.asc()))
    return list(result.scalars().all())


async def list_active_users(session: AsyncSession) -> list[User]:
    result = await session.execute(
        select(User).where(User.is_active.is_(True)).order_by(User.display_name.asc(), User.username.asc())
    )
    return list(result.scalars().all())


async def create_local_user(session: AsyncSession, payload: AdminUserCreate) -> User:
    user = User(
        username=normalize_username(payload.username),
        display_name=payload.display_name.strip(),
        email=str(payload.email).lower() if payload.email else None,
        password_hash=hash_password(payload.password),
        role=payload.role,
        is_active=payload.is_active,
        auth_provider="local",
    )
    session.add(user)
    await session.commit()
    await session.refresh(user)
    return user


async def update_user(session: AsyncSession, user: User, payload: AdminUserUpdate) -> User:
    update_fields = payload.model_fields_set
    if "display_name" in update_fields and payload.display_name is not None:
        user.display_name = payload.display_name.strip()
    if "email" in update_fields:
        user.email = str(payload.email).lower() if payload.email else None
    if "role" in update_fields and payload.role is not None:
        user.role = payload.role
    if "is_active" in update_fields and payload.is_active is not None:
        user.is_active = payload.is_active

    await session.commit()
    await session.refresh(user)
    return user


async def reset_local_user_password(
    session: AsyncSession,
    user: User,
    payload: AdminPasswordReset,
) -> User:
    user.password_hash = hash_password(payload.new_password)
    await session.commit()
    await session.refresh(user)
    return user
