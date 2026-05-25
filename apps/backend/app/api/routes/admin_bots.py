from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import get_db, require_admin_user
from app.models.bot import Bot
from app.models.user import User
from app.schemas.bot import BotCreate, BotCreateResponse, BotPublic, BotTokenRotateResponse, BotUpdate
from app.services.bots import create_bot, list_bots, load_bot_with_user, rotate_bot_token, update_bot

router = APIRouter()


@router.get("", response_model=list[BotPublic])
async def get_bots(
    session: Annotated[AsyncSession, Depends(get_db)],
    _: Annotated[User, Depends(require_admin_user)],
) -> list[Bot]:
    return await list_bots(session)


@router.post("", response_model=BotCreateResponse, status_code=status.HTTP_201_CREATED)
async def post_bot(
    payload: BotCreate,
    session: Annotated[AsyncSession, Depends(get_db)],
    current_user: Annotated[User, Depends(require_admin_user)],
) -> BotCreateResponse:
    bot, token = await create_bot(session, payload, current_user)
    bot_data = BotPublic.model_validate(bot).model_dump()
    return BotCreateResponse(**bot_data, token=token)


@router.patch("/{bot_id}", response_model=BotPublic)
async def patch_bot(
    bot_id: UUID,
    payload: BotUpdate,
    session: Annotated[AsyncSession, Depends(get_db)],
    _: Annotated[User, Depends(require_admin_user)],
) -> Bot:
    bot = await load_bot_with_user(session, bot_id)
    if bot is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Bot not found")
    return await update_bot(session, bot, payload)


@router.post("/{bot_id}/rotate-token", response_model=BotTokenRotateResponse)
async def post_rotate_token(
    bot_id: UUID,
    session: Annotated[AsyncSession, Depends(get_db)],
    _: Annotated[User, Depends(require_admin_user)],
) -> BotTokenRotateResponse:
    bot = await load_bot_with_user(session, bot_id)
    if bot is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Bot not found")

    updated_bot, token = await rotate_bot_token(session, bot)
    return BotTokenRotateResponse(bot=BotPublic.model_validate(updated_bot), token=token)
