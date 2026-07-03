from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Request, status
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import get_db
from app.schemas.bot import IncomingBotMessage
from app.schemas.message import MessagePublic
from app.services.bots import authenticate_bot_by_token
from app.services.audit import record_audit_event_best_effort, should_record_security_event, token_fingerprint
from app.services.groups import get_group, get_group_by_slug, get_group_membership
from app.services.messages import create_group_message
from app.services.personal_notifications import broadcast_group_message_created

router = APIRouter()


@router.post("/incoming/{token}", response_model=MessagePublic)
async def incoming_bot_message(
    token: str,
    payload: IncomingBotMessage,
    request: Request,
    session: Annotated[AsyncSession, Depends(get_db)],
):
    bot = await authenticate_bot_by_token(session, token)
    if bot is None:
        fingerprint = token_fingerprint(token)
        source_ip = request.client.host if request.client else "unknown"
        if should_record_security_event(f"bot-webhook:{source_ip}:{fingerprint}"):
            await record_audit_event_best_effort(
                event_type="bot.webhook.failed", category="bots", action="incoming_webhook", status="failure",
                target_type="bot", details={"token_fingerprint": fingerprint},
                error_code="invalid_or_inactive_token", request=request,
            )
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid or inactive bot token")

    group = await get_group(session, payload.group_id) if payload.group_id else None
    if group is None and payload.group_slug:
        group = await get_group_by_slug(session, payload.group_slug)
    if group is None:
        await record_audit_event_best_effort(
            event_type="bot.webhook.failed", category="bots", action="incoming_webhook", status="failure",
            actor=bot.user, target_type="group", target_label=payload.group_slug,
            details={"reason": "group_not_found"}, error_code="group_not_found", request=request,
        )
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Group not found")
    if not group.is_active:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Group is inactive")

    membership = await get_group_membership(session, group.id, bot.user_id)
    if membership is None:
        await record_audit_event_best_effort(
            event_type="bot.webhook.failed", category="bots", action="incoming_webhook", status="denied",
            actor=bot.user, target_type="group", target_id=group.id, target_label=group.name,
            details={"reason": "not_group_member"}, error_code="group_membership_required", request=request,
        )
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Bot is not a group member")

    try:
        message = await create_group_message(session, group, bot.user, payload.to_message_create())
    except ValueError as exc:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail=str(exc)) from exc

    await broadcast_group_message_created(session, group, message)
    return message
