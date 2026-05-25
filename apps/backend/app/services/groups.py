import re
from uuid import UUID

from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.models.group import Group, GroupMember
from app.models.user import User
from app.schemas.group import GroupCreate, GroupMemberCreate, GroupMemberUpdate, GroupUpdate
from app.services.users import get_user_by_id, get_user_by_username

GLOBAL_GROUP_ADMINS = {"superadmin", "admin"}


def is_global_group_admin(user: User) -> bool:
    return user.role in GLOBAL_GROUP_ADMINS


def normalize_slug(slug: str) -> str:
    normalized = re.sub(r"[^a-z0-9-]+", "-", slug.strip().lower())
    normalized = re.sub(r"-+", "-", normalized).strip("-")
    if not normalized:
        raise ValueError("Group slug cannot be empty")
    return normalized


async def get_group(session: AsyncSession, group_id: UUID) -> Group | None:
    result = await session.execute(select(Group).where(Group.id == group_id))
    return result.scalar_one_or_none()


async def get_group_by_slug(session: AsyncSession, slug: str) -> Group | None:
    result = await session.execute(select(Group).where(Group.slug == normalize_slug(slug)))
    return result.scalar_one_or_none()


async def get_group_membership(
    session: AsyncSession,
    group_id: UUID,
    user_id: UUID,
) -> GroupMember | None:
    result = await session.execute(
        select(GroupMember).where(GroupMember.group_id == group_id, GroupMember.user_id == user_id)
    )
    return result.scalar_one_or_none()


async def list_visible_groups(session: AsyncSession, current_user: User) -> list[Group]:
    if is_global_group_admin(current_user):
        result = await session.execute(select(Group).order_by(Group.created_at.asc()))
    else:
        result = await session.execute(
            select(Group)
            .join(GroupMember, GroupMember.group_id == Group.id)
            .where(GroupMember.user_id == current_user.id)
            .order_by(Group.created_at.asc())
        )
    return list(result.scalars().all())


async def ensure_group_visible(session: AsyncSession, group: Group, current_user: User) -> None:
    if is_global_group_admin(current_user):
        return
    membership = await get_group_membership(session, group.id, current_user.id)
    if membership is None:
        raise PermissionError("Group access denied")


async def ensure_group_manageable(session: AsyncSession, group: Group, current_user: User) -> None:
    if is_global_group_admin(current_user):
        return
    membership = await get_group_membership(session, group.id, current_user.id)
    if membership is None or membership.role != "owner":
        raise PermissionError("Group owner role required")


async def create_group(session: AsyncSession, payload: GroupCreate, current_user: User) -> Group:
    group = Group(
        name=payload.name.strip(),
        slug=normalize_slug(payload.slug),
        description=payload.description.strip() if payload.description else None,
        is_private=payload.is_private,
        is_active=payload.is_active,
        created_by_user_id=current_user.id,
    )
    session.add(group)
    await session.flush()

    if current_user.role != "bot":
        session.add(GroupMember(group_id=group.id, user_id=current_user.id, role="owner"))

    await session.commit()
    await session.refresh(group)
    return group


async def update_group(session: AsyncSession, group: Group, payload: GroupUpdate) -> Group:
    update_fields = payload.model_fields_set
    if "name" in update_fields and payload.name is not None:
        group.name = payload.name.strip()
    if "description" in update_fields:
        group.description = payload.description.strip() if payload.description else None
    if "is_private" in update_fields and payload.is_private is not None:
        group.is_private = payload.is_private
    if "is_active" in update_fields and payload.is_active is not None:
        group.is_active = payload.is_active

    await session.commit()
    await session.refresh(group)
    return group


async def list_group_members(session: AsyncSession, group: Group) -> list[GroupMember]:
    result = await session.execute(
        select(GroupMember)
        .options(selectinload(GroupMember.user))
        .where(GroupMember.group_id == group.id)
        .order_by(GroupMember.joined_at.asc())
    )
    return list(result.scalars().all())


async def count_group_owners(session: AsyncSession, group_id: UUID) -> int:
    result = await session.execute(
        select(func.count(GroupMember.id)).where(GroupMember.group_id == group_id, GroupMember.role == "owner")
    )
    return int(result.scalar_one())


async def count_group_members(session: AsyncSession, group_id: UUID) -> int:
    result = await session.execute(select(func.count(GroupMember.id)).where(GroupMember.group_id == group_id))
    return int(result.scalar_one())


async def add_group_member(
    session: AsyncSession,
    group: Group,
    payload: GroupMemberCreate,
) -> GroupMember:
    user = None
    if payload.user_id is not None:
        user = await get_user_by_id(session, payload.user_id)
    elif payload.username:
        user = await get_user_by_username(session, payload.username)
    if user is None:
        raise LookupError("User not found")

    if payload.role != "owner" and await count_group_members(session, group.id) == 0:
        raise ValueError("First group member must be an owner")

    member = GroupMember(group_id=group.id, user_id=user.id, role=payload.role)
    session.add(member)
    await session.commit()
    await session.refresh(member)

    result = await session.execute(
        select(GroupMember).options(selectinload(GroupMember.user)).where(GroupMember.id == member.id)
    )
    loaded_member = result.scalar_one()
    return loaded_member


async def update_group_member(
    session: AsyncSession,
    member: GroupMember,
    payload: GroupMemberUpdate,
) -> GroupMember:
    if member.role == "owner" and payload.role != "owner" and await count_group_owners(session, member.group_id) <= 1:
        raise ValueError("Cannot remove the last group owner")

    member.role = payload.role
    await session.commit()
    await session.refresh(member)

    result = await session.execute(
        select(GroupMember).options(selectinload(GroupMember.user)).where(GroupMember.id == member.id)
    )
    return result.scalar_one()


async def get_group_member(session: AsyncSession, group_id: UUID, member_id: UUID) -> GroupMember | None:
    result = await session.execute(
        select(GroupMember).options(selectinload(GroupMember.user)).where(
            GroupMember.id == member_id,
            GroupMember.group_id == group_id,
        )
    )
    return result.scalar_one_or_none()


async def remove_group_member(session: AsyncSession, member: GroupMember) -> None:
    if member.role == "owner" and await count_group_owners(session, member.group_id) <= 1:
        raise ValueError("Cannot remove the last group owner")

    await session.delete(member)
    await session.commit()
