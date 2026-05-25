from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import get_db
from app.schemas.bot import IncomingBotMessage
from app.schemas.message import MessagePublic
from app.services.bots import authenticate_bot_by_token
from app.services.groups import get_group, get_group_by_slug, get_group_membership
from app.services.messages import create_group_message
from app.services.websocket_manager import group_websocket_manager

router = APIRouter()


def message_event_payload(event_type: str, group_id: object, message: object) -> dict[str, object]:
    serialized_message = MessagePublic.model_validate(message).model_dump(mode="json")
    return {
        "type": event_type,
        "group_id": str(group_id),
        "message": serialized_message,
    }


@router.post("/incoming/{token}", response_model=MessagePublic)
async def incoming_bot_message(
    token: str,
    payload: IncomingBotMessage,
    session: Annotated[AsyncSession, Depends(get_db)],
):
    bot = await authenticate_bot_by_token(session, token)
    if bot is None:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid or inactive bot token")

    group = await get_group(session, payload.group_id) if payload.group_id else None
    if group is None and payload.group_slug:
        group = await get_group_by_slug(session, payload.group_slug)
    if group is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Group not found")
    if not group.is_active:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Group is inactive")

    membership = await get_group_membership(session, group.id, bot.user_id)
    if membership is None:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Bot is not a group member")

    try:
        message = await create_group_message(session, group, bot.user, payload.to_message_create())
    except ValueError as exc:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail=str(exc)) from exc

    await group_websocket_manager.broadcast_to_group(
        group.id,
        message_event_payload("message.created", group.id, message),
    )
    return message
