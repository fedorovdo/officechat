from typing import Annotated
from uuid import UUID

import jwt
from fastapi import APIRouter, Depends, Query, WebSocket, WebSocketDisconnect, status
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import get_db
from app.models.user import User
from app.services.groups import get_group
from app.services.messages import ensure_group_message_access
from app.services.security import decode_access_token
from app.services.users import get_user_by_id
from app.services.websocket_manager import group_websocket_manager

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


@router.websocket("/groups/{group_id}")
async def group_messages_websocket(
    websocket: WebSocket,
    group_id: UUID,
    session: Annotated[AsyncSession, Depends(get_db)],
    token: Annotated[str | None, Query()] = None,
) -> None:
    if token is None:
        await websocket.close(code=status.WS_1008_POLICY_VIOLATION)
        return

    current_user = await get_websocket_user(session, token)
    if current_user is None:
        await websocket.close(code=status.WS_1008_POLICY_VIOLATION)
        return

    group = await get_group(session, group_id)
    if group is None:
        await websocket.close(code=status.WS_1008_POLICY_VIOLATION)
        return

    try:
        await ensure_group_message_access(session, group, current_user)
    except PermissionError:
        await websocket.close(code=status.WS_1008_POLICY_VIOLATION)
        return

    await group_websocket_manager.connect(group_id, websocket)
    try:
        while True:
            await websocket.receive_text()
    except WebSocketDisconnect:
        group_websocket_manager.disconnect(group_id, websocket)
