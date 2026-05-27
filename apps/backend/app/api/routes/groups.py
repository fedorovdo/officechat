from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Depends, File, Form, HTTPException, Query, Response, UploadFile, status
from fastapi.responses import FileResponse
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import get_current_user, get_db
from app.models.group import Group, GroupMember
from app.models.user import User
from app.schemas.group import (
    GroupCreate,
    GroupMemberCreate,
    GroupMemberPublic,
    GroupMemberUpdate,
    GroupPublic,
    GroupUpdate,
)
from app.schemas.message import MessageCreate, MessagePublic, MessageUpdate
from app.services.attachments import (
    create_message_with_attachment,
    get_group_attachment,
    resolve_attachment_path,
)
from app.services.groups import (
    add_group_member,
    create_group,
    ensure_group_manageable,
    ensure_group_visible,
    get_group,
    get_group_member,
    is_global_group_admin,
    list_group_members,
    list_visible_groups,
    remove_group_member,
    update_group,
    update_group_member,
)
from app.services.messages import (
    create_group_message,
    delete_group_message,
    ensure_group_message_access,
    get_group_message,
    list_group_messages,
    update_group_message,
)
from app.services.websocket_manager import group_websocket_manager

router = APIRouter()


async def load_group_or_404(session: AsyncSession, group_id: UUID) -> Group:
    group = await get_group(session, group_id)
    if group is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Group not found")
    return group


def raise_for_permission_error(exc: PermissionError) -> None:
    raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail=str(exc)) from exc


def message_event_payload(event_type: str, group_id: UUID, message: object) -> dict[str, object]:
    serialized_message = MessagePublic.model_validate(message).model_dump(mode="json")
    event: dict[str, object] = {
        "type": event_type,
        "group_id": str(group_id),
        "message": serialized_message,
    }
    if event_type == "message.deleted":
        event["message_id"] = serialized_message["id"]
    return event


@router.get("", response_model=list[GroupPublic])
async def list_groups(
    session: Annotated[AsyncSession, Depends(get_db)],
    current_user: Annotated[User, Depends(get_current_user)],
    include_inactive: bool = False,
) -> list[Group]:
    if include_inactive and not is_global_group_admin(current_user):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Admin role required")
    return await list_visible_groups(session, current_user, include_inactive=include_inactive)


@router.post("", response_model=GroupPublic, status_code=status.HTTP_201_CREATED)
async def post_group(
    payload: GroupCreate,
    session: Annotated[AsyncSession, Depends(get_db)],
    current_user: Annotated[User, Depends(get_current_user)],
) -> Group:
    if not is_global_group_admin(current_user):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Admin role required")

    try:
        return await create_group(session, payload, current_user)
    except ValueError as exc:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail=str(exc)) from exc
    except IntegrityError as exc:
        await session.rollback()
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Group slug already exists") from exc


@router.get("/{group_id}", response_model=GroupPublic)
async def get_group_by_id(
    group_id: UUID,
    session: Annotated[AsyncSession, Depends(get_db)],
    current_user: Annotated[User, Depends(get_current_user)],
) -> Group:
    group = await load_group_or_404(session, group_id)
    try:
        await ensure_group_visible(session, group, current_user)
    except PermissionError as exc:
        raise_for_permission_error(exc)
    return group


@router.patch("/{group_id}", response_model=GroupPublic)
async def patch_group(
    group_id: UUID,
    payload: GroupUpdate,
    session: Annotated[AsyncSession, Depends(get_db)],
    current_user: Annotated[User, Depends(get_current_user)],
) -> Group:
    group = await load_group_or_404(session, group_id)
    try:
        await ensure_group_manageable(session, group, current_user)
    except PermissionError as exc:
        raise_for_permission_error(exc)
    return await update_group(session, group, payload)


@router.get("/{group_id}/members", response_model=list[GroupMemberPublic])
async def get_members(
    group_id: UUID,
    session: Annotated[AsyncSession, Depends(get_db)],
    current_user: Annotated[User, Depends(get_current_user)],
) -> list[GroupMember]:
    group = await load_group_or_404(session, group_id)
    try:
        await ensure_group_visible(session, group, current_user)
    except PermissionError as exc:
        raise_for_permission_error(exc)
    return await list_group_members(session, group)


@router.post("/{group_id}/members", response_model=GroupMemberPublic, status_code=status.HTTP_201_CREATED)
async def post_member(
    group_id: UUID,
    payload: GroupMemberCreate,
    session: Annotated[AsyncSession, Depends(get_db)],
    current_user: Annotated[User, Depends(get_current_user)],
) -> GroupMember:
    group = await load_group_or_404(session, group_id)
    try:
        await ensure_group_manageable(session, group, current_user)
        return await add_group_member(session, group, payload)
    except PermissionError as exc:
        raise_for_permission_error(exc)
    except LookupError as exc:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)) from exc
    except IntegrityError as exc:
        await session.rollback()
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="User is already a group member") from exc


@router.patch("/{group_id}/members/{member_id}", response_model=GroupMemberPublic)
async def patch_member(
    group_id: UUID,
    member_id: UUID,
    payload: GroupMemberUpdate,
    session: Annotated[AsyncSession, Depends(get_db)],
    current_user: Annotated[User, Depends(get_current_user)],
) -> GroupMember:
    group = await load_group_or_404(session, group_id)
    try:
        await ensure_group_manageable(session, group, current_user)
    except PermissionError as exc:
        raise_for_permission_error(exc)

    member = await get_group_member(session, group_id, member_id)
    if member is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Group member not found")

    try:
        return await update_group_member(session, member, payload)
    except ValueError as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)) from exc


@router.delete("/{group_id}/members/{member_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_member(
    group_id: UUID,
    member_id: UUID,
    session: Annotated[AsyncSession, Depends(get_db)],
    current_user: Annotated[User, Depends(get_current_user)],
) -> Response:
    group = await load_group_or_404(session, group_id)
    try:
        await ensure_group_manageable(session, group, current_user)
    except PermissionError as exc:
        raise_for_permission_error(exc)

    member = await get_group_member(session, group_id, member_id)
    if member is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Group member not found")

    try:
        await remove_group_member(session, member)
    except ValueError as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)) from exc

    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.get("/{group_id}/messages", response_model=list[MessagePublic])
async def get_messages(
    group_id: UUID,
    session: Annotated[AsyncSession, Depends(get_db)],
    current_user: Annotated[User, Depends(get_current_user)],
    limit: Annotated[int, Query(ge=1, le=100)] = 50,
    before: UUID | None = None,
):
    group = await load_group_or_404(session, group_id)
    try:
        await ensure_group_message_access(session, group, current_user)
    except PermissionError as exc:
        raise_for_permission_error(exc)
    return await list_group_messages(session, group, limit=limit, before=before)


@router.post("/{group_id}/messages", response_model=MessagePublic, status_code=status.HTTP_201_CREATED)
async def post_message(
    group_id: UUID,
    payload: MessageCreate,
    session: Annotated[AsyncSession, Depends(get_db)],
    current_user: Annotated[User, Depends(get_current_user)],
):
    group = await load_group_or_404(session, group_id)
    try:
        await ensure_group_message_access(session, group, current_user)
        message = await create_group_message(session, group, current_user, payload)
        await group_websocket_manager.broadcast_to_group(
            group_id,
            message_event_payload("message.created", group_id, message),
        )
        return message
    except PermissionError as exc:
        raise_for_permission_error(exc)
    except ValueError as exc:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail=str(exc)) from exc


@router.post("/{group_id}/messages/with-attachment", response_model=MessagePublic, status_code=status.HTTP_201_CREATED)
async def post_message_with_attachment(
    group_id: UUID,
    session: Annotated[AsyncSession, Depends(get_db)],
    current_user: Annotated[User, Depends(get_current_user)],
    body: Annotated[str | None, Form()] = None,
    file: UploadFile = File(...),
):
    group = await load_group_or_404(session, group_id)
    try:
        await ensure_group_message_access(session, group, current_user)
        message = await create_message_with_attachment(session, group, current_user, body, file)
        await group_websocket_manager.broadcast_to_group(
            group_id,
            message_event_payload("message.created", group_id, message),
        )
        return message
    except PermissionError as exc:
        raise_for_permission_error(exc)
    except ValueError as exc:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail=str(exc)) from exc


@router.patch("/{group_id}/messages/{message_id}", response_model=MessagePublic)
async def patch_message(
    group_id: UUID,
    message_id: UUID,
    payload: MessageUpdate,
    session: Annotated[AsyncSession, Depends(get_db)],
    current_user: Annotated[User, Depends(get_current_user)],
):
    group = await load_group_or_404(session, group_id)
    try:
        await ensure_group_message_access(session, group, current_user)
    except PermissionError as exc:
        raise_for_permission_error(exc)

    message = await get_group_message(session, group, message_id)
    if message is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Message not found")

    try:
        updated_message = await update_group_message(session, message, current_user, payload)
        await group_websocket_manager.broadcast_to_group(
            group_id,
            message_event_payload("message.updated", group_id, updated_message),
        )
        return updated_message
    except PermissionError as exc:
        raise_for_permission_error(exc)
    except ValueError as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)) from exc


@router.get("/{group_id}/attachments/{attachment_id}/download")
async def download_attachment(
    group_id: UUID,
    attachment_id: UUID,
    session: Annotated[AsyncSession, Depends(get_db)],
    current_user: Annotated[User, Depends(get_current_user)],
):
    group = await load_group_or_404(session, group_id)
    try:
        await ensure_group_message_access(session, group, current_user)
    except PermissionError as exc:
        raise_for_permission_error(exc)

    attachment = await get_group_attachment(session, group, attachment_id)
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


@router.delete("/{group_id}/messages/{message_id}", response_model=MessagePublic)
async def delete_message(
    group_id: UUID,
    message_id: UUID,
    session: Annotated[AsyncSession, Depends(get_db)],
    current_user: Annotated[User, Depends(get_current_user)],
):
    group = await load_group_or_404(session, group_id)
    try:
        await ensure_group_message_access(session, group, current_user)
    except PermissionError as exc:
        raise_for_permission_error(exc)

    message = await get_group_message(session, group, message_id)
    if message is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Message not found")

    try:
        deleted_message = await delete_group_message(session, group, message, current_user)
        await group_websocket_manager.broadcast_to_group(
            group_id,
            message_event_payload("message.deleted", group_id, deleted_message),
        )
        return deleted_message
    except PermissionError as exc:
        raise_for_permission_error(exc)
