from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query, Request, Response, status
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import get_current_user, get_db
from app.models.pin import PinnedMessage
from app.models.user import User
from app.schemas.pin import ChatType, PinCreate, PinnedMessagePublic, PinUpdate
from app.services.audit import record_audit_event
from app.services.pins import (
    PinConflictError,
    create_pin,
    delete_pin,
    ensure_pin_chat_access,
    get_pin,
    list_pins,
    serialize_pin,
    serialize_pins,
    update_pin,
)
from app.services.direct import get_direct_conversation
from app.services.discussions import list_active_discussion_member_user_ids
from app.services.notifications import safe_create_notification
from app.services.personal_notifications import list_active_group_member_user_ids
from app.services.websocket_manager import (
    direct_websocket_manager,
    discussion_websocket_manager,
    group_websocket_manager,
)

router = APIRouter()


def raise_for_permission_error(exc: PermissionError) -> None:
    raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail=str(exc)) from exc


async def broadcast_pin_event(event_type: str, pin: PinnedMessage, payload: dict[str, object]) -> None:
    if pin.chat_type == "group":
        await group_websocket_manager.broadcast_to_group(pin.chat_id, payload)
    elif pin.chat_type == "direct":
        await direct_websocket_manager.broadcast_to_conversation(pin.chat_id, payload)
    else:
        await discussion_websocket_manager.broadcast_to_discussion(pin.chat_id, payload)


async def pin_recipient_ids(session: AsyncSession, pin: PinnedMessage) -> list[UUID]:
    if pin.chat_type == "group":
        return await list_active_group_member_user_ids(session, pin.chat_id)
    if pin.chat_type == "discussion":
        return await list_active_discussion_member_user_ids(session, pin.chat_id)
    conversation = await get_direct_conversation(session, pin.chat_id)
    if conversation is None:
        return []
    return [user.id for user in (conversation.user_one, conversation.user_two) if user.is_active]


def pin_event_payload(event_type: str, pin: PinnedMessage, public_pin: PinnedMessagePublic) -> dict[str, object]:
    return {
        "type": event_type,
        "chat_type": pin.chat_type,
        "chat_id": str(pin.chat_id),
        "pin_id": str(pin.id),
        "message_id": str(pin.message_id),
        "pin": public_pin.model_dump(mode="json"),
    }


@router.get("", response_model=list[PinnedMessagePublic])
async def get_pins(
    session: Annotated[AsyncSession, Depends(get_db)],
    current_user: Annotated[User, Depends(get_current_user)],
    chat_type: ChatType,
    chat_id: Annotated[UUID, Query()],
) -> list[PinnedMessagePublic]:
    try:
        await ensure_pin_chat_access(session, chat_type, chat_id, current_user)
        return await serialize_pins(session, await list_pins(session, chat_type, chat_id))
    except LookupError as exc:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=str(exc)) from exc
    except PermissionError as exc:
        raise_for_permission_error(exc)


@router.post("", response_model=PinnedMessagePublic, status_code=status.HTTP_201_CREATED)
async def post_pin(
    payload: PinCreate,
    request: Request,
    session: Annotated[AsyncSession, Depends(get_db)],
    current_user: Annotated[User, Depends(get_current_user)],
) -> PinnedMessagePublic:
    try:
        pin, created = await create_pin(session, payload, current_user)
        if created:
            await record_audit_event(
                session,
                event_type="message.pinned",
                category="messages",
                action="pin",
                status="success",
                actor=current_user,
                target_type=f"{payload.chat_type}_message",
                target_id=payload.message_id,
                target_label=f"{payload.chat_type}:{payload.chat_id}",
                details={
                    "chat_type": payload.chat_type,
                    "chat_id": str(payload.chat_id),
                    "message_id": str(payload.message_id),
                    "note_length": len(payload.note or ""),
                },
                request=request,
            )
            await session.commit()
            pin = await get_pin(session, pin.id) or pin
            public_pin = await serialize_pin(session, pin)
            await broadcast_pin_event("message.pinned", pin, pin_event_payload("message.pinned", pin, public_pin))
            for user_id in await pin_recipient_ids(session, pin):
                await safe_create_notification(
                    session,
                    recipient_user_id=user_id,
                    notification_type="pin",
                    category="pins",
                    actor=current_user,
                    source_type="pin",
                    source_id=pin.id,
                    chat_type=pin.chat_type,
                    chat_id=pin.chat_id,
                    message_id=pin.message_id,
                    title_key="notification.pin",
                    body_preview=public_pin.message.body_preview,
                    metadata={"source_label": f"{pin.chat_type}:{pin.chat_id}"},
                )
            return public_pin

        public_pin = await serialize_pin(session, pin)
        return public_pin
    except LookupError as exc:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=str(exc)) from exc
    except PermissionError as exc:
        raise_for_permission_error(exc)
    except PinConflictError as exc:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail=str(exc)) from exc
    except IntegrityError as exc:
        await session.rollback()
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Message is already pinned") from exc


@router.patch("/{pin_id}", response_model=PinnedMessagePublic)
async def patch_pin(
    pin_id: UUID,
    payload: PinUpdate,
    request: Request,
    session: Annotated[AsyncSession, Depends(get_db)],
    current_user: Annotated[User, Depends(get_current_user)],
) -> PinnedMessagePublic:
    pin = await get_pin(session, pin_id)
    if pin is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Pin not found")
    try:
        old_note_length = len(pin.note or "")
        pin = await update_pin(session, pin, payload, current_user)
        await record_audit_event(
            session,
            event_type="message.pin_note_updated",
            category="messages",
            action="update_pin_note",
            status="success",
            actor=current_user,
            target_type=f"{pin.chat_type}_message",
            target_id=pin.message_id,
            target_label=f"{pin.chat_type}:{pin.chat_id}",
            details={
                "chat_type": pin.chat_type,
                "chat_id": str(pin.chat_id),
                "message_id": str(pin.message_id),
                "old_note_length": old_note_length,
                "new_note_length": len(pin.note or ""),
            },
            request=request,
        )
        await session.commit()
        pin = await get_pin(session, pin.id) or pin
        public_pin = await serialize_pin(session, pin)
        await broadcast_pin_event(
            "message.pin_updated",
            pin,
            pin_event_payload("message.pin_updated", pin, public_pin),
        )
        return public_pin
    except LookupError as exc:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=str(exc)) from exc
    except PermissionError as exc:
        raise_for_permission_error(exc)
    except ValueError as exc:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail=str(exc)) from exc


@router.delete("/{pin_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_pin_by_id(
    pin_id: UUID,
    request: Request,
    session: Annotated[AsyncSession, Depends(get_db)],
    current_user: Annotated[User, Depends(get_current_user)],
) -> Response:
    pin = await get_pin(session, pin_id)
    if pin is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Pin not found")
    event_pin = pin
    try:
        await delete_pin(session, pin, current_user)
        await record_audit_event(
            session,
            event_type="message.unpinned",
            category="messages",
            action="unpin",
            status="success",
            actor=current_user,
            target_type=f"{event_pin.chat_type}_message",
            target_id=event_pin.message_id,
            target_label=f"{event_pin.chat_type}:{event_pin.chat_id}",
            details={
                "chat_type": event_pin.chat_type,
                "chat_id": str(event_pin.chat_id),
                "message_id": str(event_pin.message_id),
            },
            request=request,
        )
        await session.commit()
        await broadcast_pin_event(
            "message.unpinned",
            event_pin,
            {
                "type": "message.unpinned",
                "chat_type": event_pin.chat_type,
                "chat_id": str(event_pin.chat_id),
                "pin_id": str(event_pin.id),
                "message_id": str(event_pin.message_id),
            },
        )
        return Response(status_code=status.HTTP_204_NO_CONTENT)
    except LookupError as exc:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=str(exc)) from exc
    except PermissionError as exc:
        raise_for_permission_error(exc)
    except ValueError as exc:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail=str(exc)) from exc
