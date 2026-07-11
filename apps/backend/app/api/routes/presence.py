from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query, status
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import get_current_user, get_db
from app.models.user import User
from app.schemas.user import PresencePublic
from app.services.presence import get_presence, visible_presence_user_ids

router = APIRouter()
MAX_PRESENCE_USERS = 100


class PresenceQuery(BaseModel):
    user_ids: list[UUID] = Field(default_factory=list, max_length=MAX_PRESENCE_USERS)


async def build_presence_snapshot(
    user_ids: list[UUID],
    session: Annotated[AsyncSession, Depends(get_db)],
    current_user: Annotated[User, Depends(get_current_user)],
) -> list[dict[str, object]]:
    requested_ids = set(user_ids)
    if not requested_ids:
        return []
    if len(requested_ids) > MAX_PRESENCE_USERS:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=f"At most {MAX_PRESENCE_USERS} users may be requested",
        )

    visible_ids = await visible_presence_user_ids(session, current_user, requested_ids)
    result = await session.execute(
        select(User).where(User.id.in_(visible_ids), User.is_active.is_(True))
    )
    users = list(result.scalars().all())
    return [await get_presence(user) for user in users]


@router.get("", response_model=list[PresencePublic])
async def get_presence_snapshot(
    user_ids: Annotated[list[UUID], Query()],
    session: Annotated[AsyncSession, Depends(get_db)],
    current_user: Annotated[User, Depends(get_current_user)],
) -> list[dict[str, object]]:
    return await build_presence_snapshot(user_ids, session, current_user)


@router.post("/query", response_model=list[PresencePublic])
async def query_presence_snapshot(
    payload: PresenceQuery,
    session: Annotated[AsyncSession, Depends(get_db)],
    current_user: Annotated[User, Depends(get_current_user)],
) -> list[dict[str, object]]:
    return await build_presence_snapshot(payload.user_ids, session, current_user)
