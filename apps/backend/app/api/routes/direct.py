from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Depends, File, Form, HTTPException, Query, UploadFile, status
from fastapi.responses import FileResponse
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
from app.schemas.reaction import MessageReactionPublic, ReactionChange, serialize_reactions
from app.services.direct import (
    create_direct_message,
    create_direct_message_with_attachment,
    create_direct_message_with_attachments,
    create_or_get_direct_conversation,
    delete_direct_message,
    ensure_direct_conversation_access,
    get_direct_conversation,
    get_direct_attachment,
    get_direct_message,
    get_last_direct_message,
    get_other_user,
    list_direct_conversations,
    list_direct_messages,
    list_archived_direct_messages,
    update_direct_message,
)
from app.services.attachments import resolve_attachment_path
from app.services.personal_notifications import broadcast_direct_message_created, direct_message_event_payload
from app.services.pins import annotate_messages_with_pins, delete_pins_for_message
from app.services.reactions import add_direct_message_reaction, remove_direct_message_reaction
from app.services.websocket_manager import direct_websocket_manager
from app.services.unread import broadcast_unread_for_chat

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
    last_message = await get_last_direct_message(session, conversation)
    if last_message is not None:
        await annotate_messages_with_pins(session, "direct", conversation.id, [last_message])
    return DirectConversationPublic(
        id=conversation.id,
        user_one_id=conversation.user_one_id,
        user_two_id=conversation.user_two_id,
        created_at=conversation.created_at,
        updated_at=conversation.updated_at,
        other_user=get_other_user(conversation, current_user),
        last_message=(
            DirectMessagePublic.model_validate(last_message, context={"current_user_id": current_user.id})
            if last_message is not None
            else None
        ),
    )


def serialize_message(message: DirectMessage, current_user: User) -> DirectMessagePublic:
    return DirectMessagePublic.model_validate(message, context={"current_user_id": current_user.id})


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
    before: UUID | None = None,
) -> list[DirectMessage]:
    conversation = await load_conversation_or_404(session, conversation_id)
    try:
        ensure_direct_conversation_access(conversation, current_user)
        messages = await list_direct_messages(session, conversation, limit=limit, before=before)
        await annotate_messages_with_pins(session, "direct", conversation.id, messages)
        return [serialize_message(message, current_user) for message in messages]
    except PermissionError as exc:
        raise_for_permission_error(exc)


@router.get("/conversations/{conversation_id}/messages/archive", response_model=list[DirectMessagePublic])
async def get_archived_messages(
    conversation_id: UUID,
    session: Annotated[AsyncSession, Depends(get_db)],
    current_user: Annotated[User, Depends(get_current_user)],
    limit: Annotated[int, Query(ge=1, le=100)] = 50,
    before: UUID | None = None,
) -> list[DirectMessagePublic]:
    conversation = await load_conversation_or_404(session, conversation_id)
    try:
        ensure_direct_conversation_access(conversation, current_user)
        messages = await list_archived_direct_messages(session, conversation, limit, before)
        await annotate_messages_with_pins(session, "direct", conversation.id, messages)
        return [serialize_message(message, current_user) for message in messages]
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
        await broadcast_direct_message_created(session, conversation, message)
        return serialize_message(message, current_user)
    except PermissionError as exc:
        raise_for_permission_error(exc)
    except ValueError as exc:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail=str(exc)) from exc


@router.post(
    "/conversations/{conversation_id}/messages/with-attachments",
    response_model=DirectMessagePublic,
    status_code=status.HTTP_201_CREATED,
)
async def post_message_with_attachments(
    conversation_id: UUID,
    session: Annotated[AsyncSession, Depends(get_db)],
    current_user: Annotated[User, Depends(get_current_user)],
    body: Annotated[str | None, Form()] = None,
    reply_to_message_id: Annotated[UUID | None, Form()] = None,
    files: Annotated[list[UploadFile] | None, File()] = None,
) -> DirectMessage:
    conversation = await load_conversation_or_404(session, conversation_id)
    try:
        message = await create_direct_message_with_attachments(
            session, conversation, current_user, body, files or [], reply_to_message_id
        )
        await broadcast_direct_message_created(session, conversation, message)
        return serialize_message(message, current_user)
    except PermissionError as exc:
        raise_for_permission_error(exc)
    except ValueError as exc:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail=str(exc)) from exc


@router.post(
    "/conversations/{conversation_id}/messages/with-attachment",
    response_model=DirectMessagePublic,
    status_code=status.HTTP_201_CREATED,
)
async def post_message_with_attachment(
    conversation_id: UUID,
    session: Annotated[AsyncSession, Depends(get_db)],
    current_user: Annotated[User, Depends(get_current_user)],
    body: Annotated[str | None, Form()] = None,
    reply_to_message_id: Annotated[UUID | None, Form()] = None,
    file: UploadFile = File(...),
) -> DirectMessage:
    conversation = await load_conversation_or_404(session, conversation_id)
    try:
        message = await create_direct_message_with_attachment(
            session, conversation, current_user, body, file, reply_to_message_id
        )
        await broadcast_direct_message_created(session, conversation, message)
        return serialize_message(message, current_user)
    except PermissionError as exc:
        raise_for_permission_error(exc)
    except ValueError as exc:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail=str(exc)) from exc


@router.get("/conversations/{conversation_id}/attachments/{attachment_id}/download")
async def download_direct_attachment(
    conversation_id: UUID,
    attachment_id: UUID,
    session: Annotated[AsyncSession, Depends(get_db)],
    current_user: Annotated[User, Depends(get_current_user)],
):
    conversation = await load_conversation_or_404(session, conversation_id)
    try:
        ensure_direct_conversation_access(conversation, current_user)
    except PermissionError as exc:
        raise_for_permission_error(exc)

    attachment = await get_direct_attachment(session, conversation, attachment_id)
    if attachment is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Attachment not found")
    if not attachment.file_available:
        raise HTTPException(status_code=status.HTTP_410_GONE, detail="File removed by retention policy")
    try:
        attachment_path = resolve_attachment_path(attachment)
    except ValueError as exc:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=str(exc)) from exc
    if not attachment_path.exists() or not attachment_path.is_file():
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Attachment file not found")
    return FileResponse(
        path=attachment_path,
        media_type=attachment.content_type or "application/octet-stream",
        filename=attachment.original_filename,
    )


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
    except ValueError as exc:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail=str(exc)) from exc

    message = await get_direct_message(session, conversation, message_id)
    if message is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Message not found")
    if message.is_archived:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="Archived messages are read-only")

    try:
        updated_message = await update_direct_message(session, conversation, message, current_user, payload)
        await direct_websocket_manager.broadcast_to_conversation(
            conversation_id,
            direct_message_event_payload("direct.message.updated", conversation_id, updated_message),
        )
        return serialize_message(updated_message, current_user)
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
    if message.is_archived:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="Archived messages are read-only")

    try:
        await delete_pins_for_message(session, "direct", conversation.id, message.id)
        deleted_message = await delete_direct_message(session, conversation, message, current_user)
        await direct_websocket_manager.broadcast_to_conversation(
            conversation_id,
            direct_message_event_payload("direct.message.deleted", conversation_id, deleted_message),
        )
        recipient_ids = [
            user.id for user in (conversation.user_one, conversation.user_two) if user.is_active
        ]
        await broadcast_unread_for_chat(session, "direct", conversation_id, recipient_ids)
        return serialize_message(deleted_message, current_user)
    except PermissionError as exc:
        raise_for_permission_error(exc)
    except ValueError as exc:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail=str(exc)) from exc


async def change_direct_message_reaction(
    conversation_id: UUID,
    message_id: UUID,
    payload: ReactionChange,
    session: AsyncSession,
    current_user: User,
    remove: bool,
) -> list[MessageReactionPublic]:
    conversation = await load_conversation_or_404(session, conversation_id)
    try:
        ensure_direct_conversation_access(conversation, current_user)
    except PermissionError as exc:
        raise_for_permission_error(exc)

    message = await get_direct_message(session, conversation, message_id)
    if message is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Message not found")
    if message.is_archived:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="Archived messages are read-only")

    try:
        if remove:
            rows = await remove_direct_message_reaction(session, message.id, current_user, payload.emoji)
        else:
            rows = await add_direct_message_reaction(
                session, message.id, current_user, payload.emoji, message.is_deleted
            )
    except PermissionError as exc:
        raise_for_permission_error(exc)
    except ValueError as exc:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail=str(exc)) from exc

    response = serialize_reactions(rows, current_user.id)
    await direct_websocket_manager.broadcast_to_conversation(
        conversation.id,
        {
            "type": "direct.message.reactions.updated",
            "conversation_id": str(conversation.id),
            "message_id": str(message.id),
            "reactions": [item.model_dump(mode="json") for item in serialize_reactions(rows)],
        },
    )
    return response


@router.put(
    "/conversations/{conversation_id}/messages/{message_id}/reactions",
    response_model=list[MessageReactionPublic],
)
async def put_message_reaction(
    conversation_id: UUID,
    message_id: UUID,
    payload: ReactionChange,
    session: Annotated[AsyncSession, Depends(get_db)],
    current_user: Annotated[User, Depends(get_current_user)],
) -> list[MessageReactionPublic]:
    return await change_direct_message_reaction(conversation_id, message_id, payload, session, current_user, False)


@router.delete(
    "/conversations/{conversation_id}/messages/{message_id}/reactions",
    response_model=list[MessageReactionPublic],
)
async def delete_message_reaction(
    conversation_id: UUID,
    message_id: UUID,
    payload: ReactionChange,
    session: Annotated[AsyncSession, Depends(get_db)],
    current_user: Annotated[User, Depends(get_current_user)],
) -> list[MessageReactionPublic]:
    return await change_direct_message_reaction(conversation_id, message_id, payload, session, current_user, True)
