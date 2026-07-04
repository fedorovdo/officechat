import asyncio
from collections.abc import Awaitable, Callable
from typing import Annotated
from uuid import UUID, uuid4

import jwt
from fastapi import APIRouter, Query, WebSocket, WebSocketDisconnect
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.session import AsyncSessionLocal
from app.core.config import settings
from app.models.user import User
from app.services.direct import ensure_direct_conversation_access, get_direct_conversation
from app.services.discussions import ensure_discussion_access, get_discussion
from app.services.groups import get_group
from app.services.messages import ensure_group_message_access
from app.services.security import decode_access_token
from app.services.presence import refresh_connection, register_connection, unregister_connection, update_typing
from app.services.users import get_user_by_id
from app.services.websocket_manager import (
    direct_websocket_manager,
    discussion_websocket_manager,
    group_websocket_manager,
    user_websocket_manager,
)

router = APIRouter()
WS_UNAUTHORIZED = 4401
WS_FORBIDDEN = 4403


async def get_websocket_user(session: AsyncSession, token: str) -> User | None:
    try:
        payload = decode_access_token(token)
        user_id = payload.get("sub")
    except jwt.PyJWTError:
        return None

    if not isinstance(user_id, str):
        return None

    user = await get_user_by_id(session, user_id)
    if user is None or not user.is_active:
        return None
    return user


async def authorize_group_websocket(group_id: UUID, token: str) -> tuple[User | None, int | None]:
    async with AsyncSessionLocal() as session:
        current_user = await get_websocket_user(session, token)
        if current_user is None:
            return None, WS_UNAUTHORIZED

        group = await get_group(session, group_id)
        if group is None:
            return None, WS_FORBIDDEN

        try:
            await ensure_group_message_access(session, group, current_user)
        except PermissionError:
            return None, WS_FORBIDDEN

        session.expunge(current_user)
        return current_user, None


async def authorize_direct_websocket(conversation_id: UUID, token: str) -> tuple[User | None, int | None]:
    async with AsyncSessionLocal() as session:
        current_user = await get_websocket_user(session, token)
        if current_user is None:
            return None, WS_UNAUTHORIZED

        conversation = await get_direct_conversation(session, conversation_id)
        if conversation is None:
            return None, WS_FORBIDDEN

        try:
            ensure_direct_conversation_access(conversation, current_user)
        except PermissionError:
            return None, WS_FORBIDDEN

        session.expunge(current_user)
        return current_user, None


async def authorize_user_websocket(token: str) -> tuple[User | None, int | None]:
    async with AsyncSessionLocal() as session:
        current_user = await get_websocket_user(session, token)
        if current_user is None:
            return None, WS_UNAUTHORIZED
        session.expunge(current_user)
        return current_user, None


async def authorize_discussion_websocket(discussion_id: UUID, token: str) -> tuple[User | None, int | None]:
    async with AsyncSessionLocal() as session:
        current_user = await get_websocket_user(session, token)
        if current_user is None:
            return None, WS_UNAUTHORIZED

        discussion = await get_discussion(session, discussion_id)
        if discussion is None:
            return None, WS_FORBIDDEN

        try:
            await ensure_discussion_access(session, discussion, current_user)
        except PermissionError:
            return None, WS_FORBIDDEN

        session.expunge(current_user)
        return current_user, None


async def run_room_socket(
    websocket: WebSocket,
    room_type: str,
    room_id: UUID,
    current_user: User,
    broadcast: Callable[[UUID, dict[str, object]], Awaitable[None]],
) -> None:
    connection_id = str(uuid4())
    expiry_task: asyncio.Task[None] | None = None

    async def emit(is_typing: bool) -> None:
        await broadcast(
            room_id,
            {
                "type": "typing.updated",
                "user_id": str(current_user.id),
                "display_name": current_user.display_name,
                "is_typing": is_typing,
            },
        )

    async def expire_typing() -> None:
        try:
            await asyncio.sleep(settings.typing_ttl_seconds)
            _, still_typing = await update_typing(
                room_type, room_id, current_user.id, connection_id, False
            )
            if not still_typing:
                await emit(False)
        except asyncio.CancelledError:
            return

    try:
        while True:
            payload = await websocket.receive_json()
            if not isinstance(payload, dict):
                continue
            event_type = payload.get("type")
            if event_type == "typing.start":
                changed, is_typing = await update_typing(
                    room_type, room_id, current_user.id, connection_id, True
                )
                if changed and is_typing:
                    await emit(True)
                if expiry_task is not None:
                    expiry_task.cancel()
                expiry_task = asyncio.create_task(expire_typing())
            elif event_type == "typing.stop":
                if expiry_task is not None:
                    expiry_task.cancel()
                    expiry_task = None
                changed, is_typing = await update_typing(
                    room_type, room_id, current_user.id, connection_id, False
                )
                if changed and not is_typing:
                    await emit(False)
    except WebSocketDisconnect:
        pass
    finally:
        if expiry_task is not None:
            expiry_task.cancel()
        changed, is_typing = await update_typing(
            room_type, room_id, current_user.id, connection_id, False
        )
        if changed and not is_typing:
            await emit(False)


@router.websocket("/groups/{group_id}")
async def group_messages_websocket(
    websocket: WebSocket,
    group_id: UUID,
    token: Annotated[str | None, Query()] = None,
) -> None:
    if token is None:
        await websocket.close(code=WS_UNAUTHORIZED)
        return

    current_user, close_code = await authorize_group_websocket(group_id, token)
    if close_code is not None or current_user is None:
        await websocket.close(code=close_code or WS_FORBIDDEN)
        return

    await group_websocket_manager.connect(group_id, websocket)
    try:
        await run_room_socket(
            websocket, "group", group_id, current_user, group_websocket_manager.broadcast_to_group
        )
    finally:
        group_websocket_manager.disconnect(group_id, websocket)


@router.websocket("/direct/{conversation_id}")
async def direct_messages_websocket(
    websocket: WebSocket,
    conversation_id: UUID,
    token: Annotated[str | None, Query()] = None,
) -> None:
    if token is None:
        await websocket.close(code=WS_UNAUTHORIZED)
        return

    current_user, close_code = await authorize_direct_websocket(conversation_id, token)
    if close_code is not None or current_user is None:
        await websocket.close(code=close_code or WS_FORBIDDEN)
        return

    await direct_websocket_manager.connect(conversation_id, websocket)
    try:
        await run_room_socket(
            websocket,
            "direct",
            conversation_id,
            current_user,
            direct_websocket_manager.broadcast_to_conversation,
        )
    finally:
        direct_websocket_manager.disconnect(conversation_id, websocket)


@router.websocket("/me")
async def personal_notifications_websocket(
    websocket: WebSocket,
    token: Annotated[str | None, Query()] = None,
) -> None:
    if token is None:
        await websocket.close(code=WS_UNAUTHORIZED)
        return

    current_user, close_code = await authorize_user_websocket(token)
    if close_code is not None or current_user is None:
        await websocket.close(code=close_code or WS_UNAUTHORIZED)
        return

    connection_id = str(uuid4())
    await user_websocket_manager.connect_user(current_user.id, websocket)
    await register_connection(current_user.id, connection_id)
    try:
        while True:
            payload = await websocket.receive_json()
            if isinstance(payload, dict) and payload.get("type") == "heartbeat":
                await refresh_connection(current_user.id, connection_id)
    except WebSocketDisconnect:
        pass
    finally:
        await unregister_connection(current_user.id, connection_id)
        user_websocket_manager.disconnect_user(current_user.id, websocket)


@router.websocket("/discussions/{discussion_id}")
async def discussion_messages_websocket(
    websocket: WebSocket,
    discussion_id: UUID,
    token: Annotated[str | None, Query()] = None,
) -> None:
    if token is None:
        await websocket.close(code=WS_UNAUTHORIZED)
        return

    current_user, close_code = await authorize_discussion_websocket(discussion_id, token)
    if close_code is not None or current_user is None:
        await websocket.close(code=close_code or WS_FORBIDDEN)
        return

    await discussion_websocket_manager.connect(discussion_id, current_user.id, websocket)
    try:
        await run_room_socket(
            websocket,
            "discussion",
            discussion_id,
            current_user,
            discussion_websocket_manager.broadcast_to_discussion,
        )
    finally:
        discussion_websocket_manager.disconnect(discussion_id, websocket)
