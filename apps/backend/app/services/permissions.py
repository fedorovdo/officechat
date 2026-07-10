import uuid
from collections.abc import Iterable
from datetime import datetime, timezone
from uuid import UUID

from fastapi import HTTPException, status
from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.permissions import ALL_PERMISSION_KEYS, PERMISSION_CATALOG
from app.models.permission import Permission, UserPermission
from app.models.user import User
from app.schemas.permission import UserPermissionState
from app.services.audit import record_audit_event
from app.services.websocket_manager import user_websocket_manager


class PermissionValidationError(ValueError):
    pass


def normalize_permission_keys(keys: Iterable[str]) -> list[str]:
    seen: set[str] = set()
    normalized: list[str] = []
    for key in keys:
        item = str(key).strip()
        if not item or item in seen:
            continue
        seen.add(item)
        normalized.append(item)
    return normalized


async def seed_permission_catalog(session: AsyncSession) -> None:
    for key, metadata in PERMISSION_CATALOG.items():
        permission = await session.get(Permission, key)
        if permission is None:
            session.add(
                Permission(
                    key=key,
                    category=metadata["category"],
                    description_ru=metadata["description_ru"],
                    description_en=metadata["description_en"],
                    is_active=True,
                )
            )
        else:
            permission.category = metadata["category"]
            permission.description_ru = metadata["description_ru"]
            permission.description_en = metadata["description_en"]
            permission.is_active = True
    await session.flush()


async def list_permission_catalog(session: AsyncSession, *, active_only: bool = True) -> list[Permission]:
    statement = select(Permission)
    if active_only:
        statement = statement.where(Permission.is_active.is_(True))
    result = await session.execute(statement.order_by(Permission.category.asc(), Permission.key.asc()))
    return list(result.scalars().all())


async def active_permission_keys(session: AsyncSession) -> set[str]:
    result = await session.execute(select(Permission.key).where(Permission.is_active.is_(True)))
    return set(result.scalars().all())


async def validate_permission_keys(session: AsyncSession, keys: Iterable[str]) -> list[str]:
    normalized = normalize_permission_keys(keys)
    configured_keys = await active_permission_keys(session)
    unknown = sorted(set(normalized) - configured_keys)
    if unknown:
        raise PermissionValidationError(f"Unknown or inactive permission: {', '.join(unknown)}")
    return normalized


async def get_explicit_permission_keys(session: AsyncSession, user_id: UUID) -> list[str]:
    result = await session.execute(
        select(UserPermission.permission_key)
        .join(Permission, Permission.key == UserPermission.permission_key)
        .where(UserPermission.user_id == user_id, Permission.is_active.is_(True))
        .order_by(UserPermission.permission_key.asc())
    )
    return list(result.scalars().all())


async def get_effective_permission_keys(session: AsyncSession, user: User) -> list[str]:
    if not user.is_active or user.role == "bot":
        return []
    if user.role == "superadmin":
        return sorted(await active_permission_keys(session))
    return await get_explicit_permission_keys(session, user.id)


async def has_permission(session: AsyncSession, user: User, permission_key: str) -> bool:
    if permission_key not in ALL_PERMISSION_KEYS:
        return False
    return permission_key in await get_effective_permission_keys(session, user)


async def require_permission(session: AsyncSession, user: User, permission_key: str) -> None:
    if not await has_permission(session, user, permission_key):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Permission required")


async def get_user_permission_state(session: AsyncSession, user: User) -> UserPermissionState:
    return UserPermissionState(
        explicit_permissions=await get_explicit_permission_keys(session, user.id),
        effective_permissions=await get_effective_permission_keys(session, user),
        inherited_from_superadmin=user.is_active and user.role == "superadmin",
    )


async def replace_user_permissions(
    session: AsyncSession,
    *,
    actor: User,
    target_user: User,
    permission_keys: Iterable[str],
    request=None,
) -> UserPermissionState:
    if actor.role != "superadmin":
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Only superadmin can manage permissions")
    if actor.id == target_user.id:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Users cannot modify their own permissions")
    if target_user.role == "bot" or target_user.auth_provider == "bot":
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Bot users cannot receive special permissions")
    if target_user.role == "superadmin":
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Superadmin permissions are implicit")

    desired = set(await validate_permission_keys(session, permission_keys))
    existing = set(await get_explicit_permission_keys(session, target_user.id))
    to_grant = sorted(desired - existing)
    to_revoke = sorted(existing - desired)

    now = datetime.now(timezone.utc)
    for permission_key in to_grant:
        session.add(
            UserPermission(
                id=uuid.uuid4(),
                user_id=target_user.id,
                permission_key=permission_key,
                granted_by_user_id=actor.id,
                granted_at=now,
            )
        )
        await record_audit_event(
            session,
            event_type="permission.granted",
            category="security",
            action="grant_permission",
            status="success",
            actor=actor,
            target_type="user",
            target_id=target_user.id,
            target_label=target_user.username,
            details={"permission": permission_key},
            request=request,
        )

    for permission_key in to_revoke:
        await session.execute(
            delete(UserPermission).where(
                UserPermission.user_id == target_user.id,
                UserPermission.permission_key == permission_key,
            )
        )
        await record_audit_event(
            session,
            event_type="permission.revoked",
            category="security",
            action="revoke_permission",
            status="success",
            actor=actor,
            target_type="user",
            target_id=target_user.id,
            target_label=target_user.username,
            details={"permission": permission_key},
            request=request,
        )

    await session.flush()
    return await get_user_permission_state(session, target_user)


async def broadcast_permissions_updated(session: AsyncSession, user: User) -> None:
    permissions = await get_effective_permission_keys(session, user)
    await user_websocket_manager.broadcast_to_user(
        user.id,
        {"type": "permissions.updated", "permissions": permissions},
    )
