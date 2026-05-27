from typing import Annotated
from uuid import UUID

import jwt
from fastapi import APIRouter, Query, WebSocket, WebSocketDisconnect, status
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.session import AsyncSessionLocal
from app.models.user import User
from app.services.direct import ensure_direct_conversation_access, get_direct_conversation
from app.services.groups import get_group
from app.services.messages import ensure_group_message_access
from app.services.security import decode_access_token
from app.services.users import get_user_by_id
from app.services.websocket_manager import direct_websocket_manager, group_websocket_manager

router = APIRouter()


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


async def authorize_group_websocket(group_id: UUID, token: str) -> bool:
    async with AsyncSessionLocal() as session:
        current_user = await get_websocket_user(session, token)
        if current_user is None:
            return False

        group = await get_group(session, group_id)
        if group is None:
            return False

        try:
            await ensure_group_message_access(session, group, current_user)
        except PermissionError:
            return False

        return True


async def authorize_direct_websocket(conversation_id: UUID, token: str) -> bool:
    async with AsyncSessionLocal() as session:
        current_user = await get_websocket_user(session, token)
        if current_user is None:
            return False

        conversation = await get_direct_conversation(session, conversation_id)
        if conversation is None:
            return False

        try:
            ensure_direct_conversation_access(conversation, current_user)
        except PermissionError:
            return False

        return True


@router.websocket("/groups/{group_id}")
async def group_messages_websocket(
    websocket: WebSocket,
    group_id: UUID,
    token: Annotated[str | None, Query()] = None,
) -> None:
    if token is None:
        await websocket.close(code=status.WS_1008_POLICY_VIOLATION)
        return

    if not await authorize_group_websocket(group_id, token):
        await websocket.close(code=status.WS_1008_POLICY_VIOLATION)
        return

    await group_websocket_manager.connect(group_id, websocket)
    try:
        while True:
            await websocket.receive_text()
    except WebSocketDisconnect:
        group_websocket_manager.disconnect(group_id, websocket)


@router.websocket("/direct/{conversation_id}")
async def direct_messages_websocket(
    websocket: WebSocket,
    conversation_id: UUID,
    token: Annotated[str | None, Query()] = None,
) -> None:
    if token is None:
        await websocket.close(code=status.WS_1008_POLICY_VIOLATION)
        return

    if not await authorize_direct_websocket(conversation_id, token):
        await websocket.close(code=status.WS_1008_POLICY_VIOLATION)
        return

    await direct_websocket_manager.connect(conversation_id, websocket)
    try:
        while True:
            await websocket.receive_text()
    except WebSocketDisconnect:
        direct_websocket_manager.disconnect(conversation_id, websocket)
