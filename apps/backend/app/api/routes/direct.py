from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import get_current_user, get_db
from app.models.direct import DirectConversation, DirectMessage
from app.models.user import User
from app.schemas.direct import (
    DirectConversationCreate,
    DirectConversationPublic,
    DirectMessageCreate,
    DirectMessagePublic,
    DirectMessageUpdate,
)
from app.services.direct import (
    create_direct_message,
    create_or_get_direct_conversation,
    delete_direct_message,
    ensure_direct_conversation_access,
    get_direct_conversation,
    get_direct_message,
    get_last_direct_message,
    get_other_user,
    list_direct_conversations,
    list_direct_messages,
    update_direct_message,
)
from app.services.websocket_manager import direct_websocket_manager

router = APIRouter()


def raise_for_permission_error(exc: PermissionError) -> None:
    raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail=str(exc)) from exc


async def load_conversation_or_404(session: AsyncSession, conversation_id: UUID) -> DirectConversation:
    conversation = await get_direct_conversation(session, conversation_id)
    if conversation is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Conversation not found")
    return conversation


async def serialize_conversation(
    session: AsyncSession,
    conversation: DirectConversation,
    current_user: User,
) -> DirectConversationPublic:
    return DirectConversationPublic(
        id=conversation.id,
        user_one_id=conversation.user_one_id,
        user_two_id=conversation.user_two_id,
        created_at=conversation.created_at,
        updated_at=conversation.updated_at,
        other_user=get_other_user(conversation, current_user),
        last_message=await get_last_direct_message(session, conversation),
    )


def direct_message_event_payload(
    event_type: str,
    conversation_id: UUID,
    message: DirectMessage,
) -> dict[str, object]:
    serialized_message = DirectMessagePublic.model_validate(message).model_dump(mode="json")
    event: dict[str, object] = {
        "type": event_type,
        "conversation_id": str(conversation_id),
        "message": serialized_message,
    }
    if event_type == "direct.message.deleted":
        event["message_id"] = serialized_message["id"]
    return event


@router.get("/conversations", response_model=list[DirectConversationPublic])
async def get_conversations(
    session: Annotated[AsyncSession, Depends(get_db)],
    current_user: Annotated[User, Depends(get_current_user)],
) -> list[DirectConversationPublic]:
    try:
        conversations = await list_direct_conversations(session, current_user)
        return [await serialize_conversation(session, conversation, current_user) for conversation in conversations]
    except PermissionError as exc:
        raise_for_permission_error(exc)


@router.post("/conversations", response_model=DirectConversationPublic, status_code=status.HTTP_201_CREATED)
async def post_conversation(
    payload: DirectConversationCreate,
    session: Annotated[AsyncSession, Depends(get_db)],
    current_user: Annotated[User, Depends(get_current_user)],
) -> DirectConversationPublic:
    try:
        conversation = await create_or_get_direct_conversation(session, current_user, payload)
        return await serialize_conversation(session, conversation, current_user)
    except IntegrityError as exc:
        await session.rollback()
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Conversation already exists") from exc
    except LookupError as exc:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=str(exc)) from exc
    except PermissionError as exc:
        raise_for_permission_error(exc)
    except ValueError as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)) from exc


@router.get("/conversations/{conversation_id}/messages", response_model=list[DirectMessagePublic])
async def get_messages(
    conversation_id: UUID,
    session: Annotated[AsyncSession, Depends(get_db)],
    current_user: Annotated[User, Depends(get_current_user)],
    limit: Annotated[int, Query(ge=1, le=100)] = 50,
) -> list[DirectMessage]:
    conversation = await load_conversation_or_404(session, conversation_id)
    try:
        ensure_direct_conversation_access(conversation, current_user)
        return await list_direct_messages(session, conversation, limit=limit)
    except PermissionError as exc:
        raise_for_permission_error(exc)


@router.post(
    "/conversations/{conversation_id}/messages",
    response_model=DirectMessagePublic,
    status_code=status.HTTP_201_CREATED,
)
async def post_message(
    conversation_id: UUID,
    payload: DirectMessageCreate,
    session: Annotated[AsyncSession, Depends(get_db)],
    current_user: Annotated[User, Depends(get_current_user)],
) -> DirectMessage:
    conversation = await load_conversation_or_404(session, conversation_id)
    try:
        message = await create_direct_message(session, conversation, current_user, payload)
        await direct_websocket_manager.broadcast_to_conversation(
            conversation_id,
            direct_message_event_payload("direct.message.created", conversation_id, message),
        )
        return message
    except PermissionError as exc:
        raise_for_permission_error(exc)
    except ValueError as exc:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail=str(exc)) from exc


@router.patch("/conversations/{conversation_id}/messages/{message_id}", response_model=DirectMessagePublic)
async def patch_message(
    conversation_id: UUID,
    message_id: UUID,
    payload: DirectMessageUpdate,
    session: Annotated[AsyncSession, Depends(get_db)],
    current_user: Annotated[User, Depends(get_current_user)],
) -> DirectMessage:
    conversation = await load_conversation_or_404(session, conversation_id)
    try:
        ensure_direct_conversation_access(conversation, current_user)
    except PermissionError as exc:
        raise_for_permission_error(exc)

    message = await get_direct_message(session, conversation, message_id)
    if message is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Message not found")

    try:
        updated_message = await update_direct_message(session, conversation, message, current_user, payload)
        await direct_websocket_manager.broadcast_to_conversation(
            conversation_id,
            direct_message_event_payload("direct.message.updated", conversation_id, updated_message),
        )
        return updated_message
    except PermissionError as exc:
        raise_for_permission_error(exc)
    except ValueError as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)) from exc


@router.delete("/conversations/{conversation_id}/messages/{message_id}", response_model=DirectMessagePublic)
async def delete_message(
    conversation_id: UUID,
    message_id: UUID,
    session: Annotated[AsyncSession, Depends(get_db)],
    current_user: Annotated[User, Depends(get_current_user)],
) -> DirectMessage:
    conversation = await load_conversation_or_404(session, conversation_id)
    try:
        ensure_direct_conversation_access(conversation, current_user)
    except PermissionError as exc:
        raise_for_permission_error(exc)

    message = await get_direct_message(session, conversation, message_id)
    if message is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Message not found")

    try:
        deleted_message = await delete_direct_message(session, conversation, message, current_user)
        await direct_websocket_manager.broadcast_to_conversation(
            conversation_id,
            direct_message_event_payload("direct.message.deleted", conversation_id, deleted_message),
        )
        return deleted_message
    except PermissionError as exc:
        raise_for_permission_error(exc)
