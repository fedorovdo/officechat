from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Request, status
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import get_db, require_admin_user
from app.models.bot import Bot
from app.models.user import User
from app.schemas.bot import BotCreate, BotCreateResponse, BotPublic, BotTokenRotateResponse, BotUpdate
from app.services.audit import record_audit_event
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
    request: Request,
    session: Annotated[AsyncSession, Depends(get_db)],
    current_user: Annotated[User, Depends(require_admin_user)],
) -> BotCreateResponse:
    bot, token = await create_bot(session, payload, current_user, commit=False)
    await record_audit_event(
        session, event_type="bot.created", category="bots", action="create", status="success",
        actor=current_user, target_type="bot", target_id=bot.id, target_label=bot.name,
        details={"username": bot.user.username, "is_active": bot.is_active}, request=request,
    )
    await session.commit()
    bot_data = BotPublic.model_validate(bot).model_dump()
    return BotCreateResponse(**bot_data, token=token)


@router.patch("/{bot_id}", response_model=BotPublic)
async def patch_bot(
    bot_id: UUID,
    payload: BotUpdate,
    request: Request,
    session: Annotated[AsyncSession, Depends(get_db)],
    current_user: Annotated[User, Depends(require_admin_user)],
) -> Bot:
    bot = await load_bot_with_user(session, bot_id)
    if bot is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Bot not found")
    before = {field: getattr(bot, field) for field in ("name", "description", "is_active")}
    updated = await update_bot(session, bot, payload, commit=False)
    changes = {
        field: {"old": before[field], "new": getattr(updated, field)}
        for field in before if before[field] != getattr(updated, field)
    }
    event_type = "bot.enabled" if "is_active" in changes and updated.is_active else (
        "bot.disabled" if "is_active" in changes else "bot.updated"
    )
    await record_audit_event(
        session, event_type=event_type, category="bots", action="update", status="success",
        actor=current_user, target_type="bot", target_id=updated.id, target_label=updated.name,
        details={"changes": changes}, request=request,
    )
    await session.commit()
    return updated


@router.post("/{bot_id}/rotate-token", response_model=BotTokenRotateResponse)
async def post_rotate_token(
    bot_id: UUID,
    request: Request,
    session: Annotated[AsyncSession, Depends(get_db)],
    current_user: Annotated[User, Depends(require_admin_user)],
) -> BotTokenRotateResponse:
    bot = await load_bot_with_user(session, bot_id)
    if bot is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Bot not found")

    updated_bot, token = await rotate_bot_token(session, bot, commit=False)
    await record_audit_event(
        session, event_type="bot.token_rotated", category="bots", action="rotate_token", status="success",
        actor=current_user, target_type="bot", target_id=updated_bot.id, target_label=updated_bot.name,
        details={"token_rotated": True}, request=request,
    )
    await session.commit()
    return BotTokenRotateResponse(bot=BotPublic.model_validate(updated_bot), token=token)
