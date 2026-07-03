from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Depends, File, Form, HTTPException, Query, Response, UploadFile, status
from fastapi.responses import FileResponse
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import get_current_user, get_db
from app.models.discussion import Discussion, DiscussionMember, DiscussionMessage
from app.models.user import User
from app.schemas.discussion import (
    DiscussionCreate,
    DiscussionMemberCreate,
    DiscussionMemberPublic,
    DiscussionMessageCreate,
    DiscussionMessagePublic,
    DiscussionMessageUpdate,
    DiscussionPublic,
)
from app.schemas.reaction import MessageReactionPublic, ReactionChange, serialize_reactions
from app.services.discussions import (
    add_discussion_member,
    can_manage_discussion_members,
    create_discussion_message,
    create_discussion_message_with_attachment,
    create_discussion_message_with_attachments,
    create_or_get_discussion,
    delete_discussion_message,
    ensure_discussion_access,
    ensure_source_message_visible,
    get_discussion,
    get_discussion_attachment,
    get_discussion_member,
    get_discussion_message,
    list_discussion_messages,
    remove_discussion_member,
    update_discussion_message,
)
from app.services.attachments import resolve_attachment_path
from app.services.personal_notifications import (
    broadcast_discussion_message_created,
    discussion_message_event_payload,
)
from app.services.reactions import add_discussion_message_reaction, remove_discussion_message_reaction
from app.services.websocket_manager import discussion_websocket_manager

router = APIRouter()


def raise_for_permission_error(exc: PermissionError) -> None:
    raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail=str(exc)) from exc


def serialize_message(message: DiscussionMessage, current_user: User) -> DiscussionMessagePublic:
    return DiscussionMessagePublic.model_validate(message, context={"current_user_id": current_user.id})


async def load_discussion_or_404(session: AsyncSession, discussion_id: UUID) -> Discussion:
    discussion = await get_discussion(session, discussion_id)
    if discussion is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Discussion not found")
    return discussion


async def serialize_discussion(
    session: AsyncSession,
    discussion: Discussion,
    current_user: User,
) -> DiscussionPublic:
    return DiscussionPublic(
        id=discussion.id,
        source_group_id=discussion.source_group_id,
        source_message_id=discussion.source_message_id,
        title=discussion.title,
        created_by_user_id=discussion.created_by_user_id,
        is_active=discussion.is_active,
        created_at=discussion.created_at,
        updated_at=discussion.updated_at,
        source_message=discussion.source_message,
        members=discussion.members,
        can_manage_members=await can_manage_discussion_members(session, discussion, current_user),
    )


@router.post("", response_model=DiscussionPublic)
async def post_discussion(
    payload: DiscussionCreate,
    session: Annotated[AsyncSession, Depends(get_db)],
    current_user: Annotated[User, Depends(get_current_user)],
) -> DiscussionPublic:
    try:
        discussion = await create_or_get_discussion(session, payload, current_user)
        return await serialize_discussion(session, discussion, current_user)
    except LookupError as exc:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=str(exc)) from exc
    except PermissionError as exc:
        raise_for_permission_error(exc)
    except IntegrityError as exc:
        await session.rollback()
        discussion = await ensure_source_message_visible(session, payload.source_message_id, current_user)
        if discussion is None:
            raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Discussion already exists") from exc
        return await serialize_discussion(session, discussion, current_user)


@router.get("/by-message/{message_id}", response_model=DiscussionPublic)
async def get_discussion_for_message(
    message_id: UUID,
    session: Annotated[AsyncSession, Depends(get_db)],
    current_user: Annotated[User, Depends(get_current_user)],
) -> DiscussionPublic:
    try:
        discussion = await ensure_source_message_visible(session, message_id, current_user)
    except PermissionError as exc:
        raise_for_permission_error(exc)
    if discussion is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Discussion not found")
    return await serialize_discussion(session, discussion, current_user)


@router.get("/{discussion_id}", response_model=DiscussionPublic)
async def get_discussion_by_id(
    discussion_id: UUID,
    session: Annotated[AsyncSession, Depends(get_db)],
    current_user: Annotated[User, Depends(get_current_user)],
) -> DiscussionPublic:
    discussion = await load_discussion_or_404(session, discussion_id)
    try:
        await ensure_discussion_access(session, discussion, current_user)
        return await serialize_discussion(session, discussion, current_user)
    except PermissionError as exc:
        raise_for_permission_error(exc)


@router.post("/{discussion_id}/members", response_model=DiscussionMemberPublic, status_code=status.HTTP_201_CREATED)
async def post_member(
    discussion_id: UUID,
    payload: DiscussionMemberCreate,
    session: Annotated[AsyncSession, Depends(get_db)],
    current_user: Annotated[User, Depends(get_current_user)],
) -> DiscussionMember:
    discussion = await load_discussion_or_404(session, discussion_id)
    try:
        member = await add_discussion_member(session, discussion, payload, current_user)
        await discussion_websocket_manager.broadcast_to_discussion(
            discussion.id,
            {
                "type": "discussion.member.added",
                "discussion_id": str(discussion.id),
                "member": DiscussionMemberPublic.model_validate(member).model_dump(mode="json"),
            },
        )
        return member
    except LookupError as exc:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=str(exc)) from exc
    except PermissionError as exc:
        raise_for_permission_error(exc)
    except ValueError as exc:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail=str(exc)) from exc
    except IntegrityError as exc:
        await session.rollback()
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="User is already a discussion member") from exc


@router.delete("/{discussion_id}/members/{member_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_member(
    discussion_id: UUID,
    member_id: UUID,
    session: Annotated[AsyncSession, Depends(get_db)],
    current_user: Annotated[User, Depends(get_current_user)],
) -> Response:
    discussion = await load_discussion_or_404(session, discussion_id)
    member = await get_discussion_member(session, discussion.id, member_id)
    if member is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Discussion member not found")

    try:
        await remove_discussion_member(session, discussion, member, current_user)
        await discussion_websocket_manager.broadcast_to_discussion(
            discussion.id,
            {
                "type": "discussion.member.removed",
                "discussion_id": str(discussion.id),
                "member_id": str(member.id),
            },
        )
        await discussion_websocket_manager.disconnect_user(discussion.id, member.user_id)
    except PermissionError as exc:
        raise_for_permission_error(exc)
    except ValueError as exc:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail=str(exc)) from exc
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.get("/{discussion_id}/messages", response_model=list[DiscussionMessagePublic])
async def get_messages(
    discussion_id: UUID,
    session: Annotated[AsyncSession, Depends(get_db)],
    current_user: Annotated[User, Depends(get_current_user)],
    limit: Annotated[int, Query(ge=1, le=100)] = 50,
) -> list[DiscussionMessage]:
    discussion = await load_discussion_or_404(session, discussion_id)
    try:
        await ensure_discussion_access(session, discussion, current_user)
        messages = await list_discussion_messages(session, discussion, limit)
        return [serialize_message(message, current_user) for message in messages]
    except PermissionError as exc:
        raise_for_permission_error(exc)


@router.post("/{discussion_id}/messages", response_model=DiscussionMessagePublic, status_code=status.HTTP_201_CREATED)
async def post_message(
    discussion_id: UUID,
    payload: DiscussionMessageCreate,
    session: Annotated[AsyncSession, Depends(get_db)],
    current_user: Annotated[User, Depends(get_current_user)],
) -> DiscussionMessage:
    discussion = await load_discussion_or_404(session, discussion_id)
    try:
        message = await create_discussion_message(session, discussion, current_user, payload)
        await broadcast_discussion_message_created(session, discussion, message)
        return serialize_message(message, current_user)
    except PermissionError as exc:
        raise_for_permission_error(exc)
    except ValueError as exc:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail=str(exc)) from exc


@router.post(
    "/{discussion_id}/messages/with-attachment",
    response_model=DiscussionMessagePublic,
    status_code=status.HTTP_201_CREATED,
)
async def post_message_with_attachment(
    discussion_id: UUID,
    session: Annotated[AsyncSession, Depends(get_db)],
    current_user: Annotated[User, Depends(get_current_user)],
    body: Annotated[str | None, Form()] = None,
    file: UploadFile = File(...),
) -> DiscussionMessage:
    discussion = await load_discussion_or_404(session, discussion_id)
    try:
        message = await create_discussion_message_with_attachment(
            session, discussion, current_user, body, file
        )
        await broadcast_discussion_message_created(session, discussion, message)
        return serialize_message(message, current_user)
    except PermissionError as exc:
        raise_for_permission_error(exc)
    except ValueError as exc:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail=str(exc)) from exc


@router.post(
    "/{discussion_id}/messages/with-attachments",
    response_model=DiscussionMessagePublic,
    status_code=status.HTTP_201_CREATED,
)
async def post_message_with_attachments(
    discussion_id: UUID,
    session: Annotated[AsyncSession, Depends(get_db)],
    current_user: Annotated[User, Depends(get_current_user)],
    body: Annotated[str | None, Form()] = None,
    files: Annotated[list[UploadFile] | None, File()] = None,
) -> DiscussionMessage:
    discussion = await load_discussion_or_404(session, discussion_id)
    try:
        message = await create_discussion_message_with_attachments(
            session, discussion, current_user, body, files or []
        )
        await broadcast_discussion_message_created(session, discussion, message)
        return serialize_message(message, current_user)
    except PermissionError as exc:
        raise_for_permission_error(exc)
    except ValueError as exc:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail=str(exc)) from exc


@router.get("/{discussion_id}/attachments/{attachment_id}/download")
async def download_discussion_attachment(
    discussion_id: UUID,
    attachment_id: UUID,
    session: Annotated[AsyncSession, Depends(get_db)],
    current_user: Annotated[User, Depends(get_current_user)],
):
    discussion = await load_discussion_or_404(session, discussion_id)
    try:
        await ensure_discussion_access(session, discussion, current_user)
    except PermissionError as exc:
        raise_for_permission_error(exc)

    attachment = await get_discussion_attachment(session, discussion, attachment_id)
    if attachment is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Attachment not found")
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


@router.patch("/{discussion_id}/messages/{message_id}", response_model=DiscussionMessagePublic)
async def patch_message(
    discussion_id: UUID,
    message_id: UUID,
    payload: DiscussionMessageUpdate,
    session: Annotated[AsyncSession, Depends(get_db)],
    current_user: Annotated[User, Depends(get_current_user)],
) -> DiscussionMessage:
    discussion = await load_discussion_or_404(session, discussion_id)
    message = await get_discussion_message(session, discussion, message_id)
    if message is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Discussion message not found")
    try:
        updated_message = await update_discussion_message(session, discussion, message, current_user, payload)
        await discussion_websocket_manager.broadcast_to_discussion(
            discussion.id,
            discussion_message_event_payload("discussion.message.updated", discussion.id, updated_message),
        )
        return serialize_message(updated_message, current_user)
    except PermissionError as exc:
        raise_for_permission_error(exc)
    except ValueError as exc:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail=str(exc)) from exc


@router.delete("/{discussion_id}/messages/{message_id}", response_model=DiscussionMessagePublic)
async def delete_message(
    discussion_id: UUID,
    message_id: UUID,
    session: Annotated[AsyncSession, Depends(get_db)],
    current_user: Annotated[User, Depends(get_current_user)],
) -> DiscussionMessage:
    discussion = await load_discussion_or_404(session, discussion_id)
    message = await get_discussion_message(session, discussion, message_id)
    if message is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Discussion message not found")
    try:
        deleted_message = await delete_discussion_message(session, discussion, message, current_user)
        await discussion_websocket_manager.broadcast_to_discussion(
            discussion.id,
            discussion_message_event_payload("discussion.message.deleted", discussion.id, deleted_message),
        )
        return serialize_message(deleted_message, current_user)
    except PermissionError as exc:
        raise_for_permission_error(exc)


async def change_discussion_message_reaction(
    discussion_id: UUID,
    message_id: UUID,
    payload: ReactionChange,
    session: AsyncSession,
    current_user: User,
    remove: bool,
) -> list[MessageReactionPublic]:
    discussion = await load_discussion_or_404(session, discussion_id)
    try:
        await ensure_discussion_access(session, discussion, current_user)
    except PermissionError as exc:
        raise_for_permission_error(exc)

    message = await get_discussion_message(session, discussion, message_id)
    if message is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Discussion message not found")

    try:
        if remove:
            rows = await remove_discussion_message_reaction(session, message.id, current_user, payload.emoji)
        else:
            rows = await add_discussion_message_reaction(
                session, message.id, current_user, payload.emoji, message.is_deleted
            )
    except PermissionError as exc:
        raise_for_permission_error(exc)
    except ValueError as exc:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail=str(exc)) from exc

    response = serialize_reactions(rows, current_user.id)
    await discussion_websocket_manager.broadcast_to_discussion(
        discussion.id,
        {
            "type": "discussion.message.reactions.updated",
            "discussion_id": str(discussion.id),
            "message_id": str(message.id),
            "reactions": [item.model_dump(mode="json") for item in serialize_reactions(rows)],
        },
    )
    return response


@router.put(
    "/{discussion_id}/messages/{message_id}/reactions",
    response_model=list[MessageReactionPublic],
)
async def put_message_reaction(
    discussion_id: UUID,
    message_id: UUID,
    payload: ReactionChange,
    session: Annotated[AsyncSession, Depends(get_db)],
    current_user: Annotated[User, Depends(get_current_user)],
) -> list[MessageReactionPublic]:
    return await change_discussion_message_reaction(
        discussion_id, message_id, payload, session, current_user, False
    )


@router.delete(
    "/{discussion_id}/messages/{message_id}/reactions",
    response_model=list[MessageReactionPublic],
)
async def delete_message_reaction(
    discussion_id: UUID,
    message_id: UUID,
    payload: ReactionChange,
    session: Annotated[AsyncSession, Depends(get_db)],
    current_user: Annotated[User, Depends(get_current_user)],
) -> list[MessageReactionPublic]:
    return await change_discussion_message_reaction(
        discussion_id, message_id, payload, session, current_user, True
    )
