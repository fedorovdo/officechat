import re
import uuid
from collections.abc import Sequence
from uuid import UUID

from sqlalchemy import func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.models.directory import DirectoryEntry
from app.models.user import User
from app.schemas.directory import DirectoryEntryCreate, DirectoryEntryUpdate

SEARCHABLE_TEXT_FIELDS = (
    DirectoryEntry.display_name,
    DirectoryEntry.department,
    DirectoryEntry.position,
    DirectoryEntry.email,
    DirectoryEntry.room,
)
PHONE_FIELDS = (
    DirectoryEntry.internal_phone,
    DirectoryEntry.work_phone,
    DirectoryEntry.mobile_phone,
)
MUTABLE_FIELDS = (
    "display_name",
    "department",
    "position",
    "internal_phone",
    "work_phone",
    "mobile_phone",
    "email",
    "room",
    "location",
    "notes",
    "linked_user_id",
)


class DirectoryEntryNotFoundError(LookupError):
    pass


class DirectoryLinkedUserNotFoundError(ValueError):
    pass


class DirectoryStateConflictError(ValueError):
    pass


def normalize_phone_search(value: str) -> str:
    return re.sub(r"\D", "", value)


def escape_like_search(value: str) -> str:
    return value.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")


def build_search_conditions(search: str) -> Sequence[object]:
    normalized = search.strip()
    if not normalized:
        return ()
    pattern = f"%{escape_like_search(normalized)}%"
    conditions: list[object] = [
        *[field.ilike(pattern, escape="\\") for field in SEARCHABLE_TEXT_FIELDS],
        DirectoryEntry.location.ilike(pattern, escape="\\"),
    ]
    phone_digits = normalize_phone_search(normalized)
    if phone_digits:
        phone_pattern = f"%{phone_digits}%"
        conditions.extend(
            func.regexp_replace(func.coalesce(field, ""), r"[^0-9]", "", "g").like(phone_pattern)
            for field in PHONE_FIELDS
        )
    return (or_(*conditions),)


async def ensure_linked_user_exists(session: AsyncSession, linked_user_id: UUID | None) -> None:
    if linked_user_id is not None and await session.get(User, linked_user_id) is None:
        raise DirectoryLinkedUserNotFoundError("Linked user not found")


async def list_directory_entries(
    session: AsyncSession,
    *,
    search: str | None,
    department: str | None,
    include_inactive: bool,
    page: int,
    limit: int,
) -> tuple[list[DirectoryEntry], int]:
    conditions: list[object] = []
    if not include_inactive:
        conditions.append(DirectoryEntry.is_active.is_(True))
    if department and department.strip():
        conditions.append(func.lower(DirectoryEntry.department) == department.strip().lower())
    if search:
        conditions.extend(build_search_conditions(search))

    total = int(await session.scalar(select(func.count(DirectoryEntry.id)).where(*conditions)) or 0)
    result = await session.execute(
        select(DirectoryEntry)
        .options(selectinload(DirectoryEntry.linked_user))
        .where(*conditions)
        .order_by(
            func.lower(DirectoryEntry.display_name).asc(),
            DirectoryEntry.display_name.asc(),
            DirectoryEntry.id.asc(),
        )
        .offset((page - 1) * limit)
        .limit(limit)
    )
    return list(result.scalars().all()), total


async def list_departments(session: AsyncSession, *, include_inactive: bool) -> list[str]:
    normalized_department = func.lower(func.trim(DirectoryEntry.department))
    statement = (
        select(func.min(DirectoryEntry.department).label("department"))
        .where(DirectoryEntry.department.is_not(None), DirectoryEntry.department != "")
        .group_by(normalized_department)
    )
    if not include_inactive:
        statement = statement.where(DirectoryEntry.is_active.is_(True))
    result = await session.execute(statement.order_by(normalized_department.asc()))
    return [department for department in result.scalars().all() if department]


async def get_directory_entry(
    session: AsyncSession,
    entry_id: UUID,
    *,
    include_inactive: bool,
) -> DirectoryEntry:
    statement = (
        select(DirectoryEntry)
        .options(selectinload(DirectoryEntry.linked_user))
        .where(DirectoryEntry.id == entry_id)
    )
    if not include_inactive:
        statement = statement.where(DirectoryEntry.is_active.is_(True))
    result = await session.execute(statement)
    entry = result.scalar_one_or_none()
    if entry is None:
        raise DirectoryEntryNotFoundError("Directory entry not found")
    return entry


async def create_directory_entry(
    session: AsyncSession,
    payload: DirectoryEntryCreate,
    actor: User,
) -> DirectoryEntry:
    await ensure_linked_user_exists(session, payload.linked_user_id)
    values = payload.model_dump()
    if values["email"] is not None:
        values["email"] = str(values["email"]).lower()
    entry = DirectoryEntry(
        id=uuid.uuid4(),
        **values,
        created_by_user_id=actor.id,
        updated_by_user_id=actor.id,
    )
    session.add(entry)
    await session.flush()
    await session.refresh(entry)
    return await get_directory_entry(session, entry.id, include_inactive=True)


async def update_directory_entry(
    session: AsyncSession,
    entry: DirectoryEntry,
    payload: DirectoryEntryUpdate,
    actor: User,
) -> tuple[DirectoryEntry, list[str]]:
    fields = payload.model_fields_set
    if "linked_user_id" in fields:
        await ensure_linked_user_exists(session, payload.linked_user_id)
    changed_fields: list[str] = []
    for field in MUTABLE_FIELDS:
        if field not in fields:
            continue
        value = getattr(payload, field)
        if field == "email" and value is not None:
            value = str(value).lower()
        if getattr(entry, field) != value:
            setattr(entry, field, value)
            changed_fields.append(field)
    if changed_fields:
        entry.updated_by_user_id = actor.id
        await session.flush()
        await session.refresh(entry)
    return await get_directory_entry(session, entry.id, include_inactive=True), changed_fields


async def set_directory_entry_active(
    session: AsyncSession,
    entry: DirectoryEntry,
    actor: User,
    *,
    is_active: bool,
) -> DirectoryEntry:
    if entry.is_active == is_active:
        state = "active" if is_active else "archived"
        raise DirectoryStateConflictError(f"Directory entry is already {state}")
    entry.is_active = is_active
    entry.updated_by_user_id = actor.id
    await session.flush()
    await session.refresh(entry)
    return await get_directory_entry(session, entry.id, include_inactive=True)
