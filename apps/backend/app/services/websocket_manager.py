import logging
from collections import defaultdict
from uuid import UUID

from fastapi import WebSocket

logger = logging.getLogger("uvicorn.error")


class GroupWebSocketManager:
    def __init__(self) -> None:
        self._connections: dict[UUID, set[WebSocket]] = defaultdict(set)

    async def connect(self, group_id: UUID, websocket: WebSocket) -> None:
        await websocket.accept()
        self._connections[group_id].add(websocket)
        logger.info("WebSocket connected to group %s; active=%s", group_id, len(self._connections[group_id]))

    def disconnect(self, group_id: UUID, websocket: WebSocket) -> None:
        connections = self._connections.get(group_id)
        if connections is None:
            return

        connections.discard(websocket)
        if not connections:
            self._connections.pop(group_id, None)
        logger.info("WebSocket disconnected from group %s; active=%s", group_id, len(connections))

    async def broadcast_to_group(self, group_id: UUID, event: dict[str, object]) -> None:
        # TODO: Use Valkey pub/sub or another broker before running multiple backend instances.
        connections = list(self._connections.get(group_id, set()))
        for websocket in connections:
            try:
                await websocket.send_json(event)
            except RuntimeError:
                self.disconnect(group_id, websocket)


group_websocket_manager = GroupWebSocketManager()


class DirectWebSocketManager:
    def __init__(self) -> None:
        self._connections: dict[UUID, set[WebSocket]] = defaultdict(set)

    async def connect(self, conversation_id: UUID, websocket: WebSocket) -> None:
        await websocket.accept()
        self._connections[conversation_id].add(websocket)
        logger.info(
            "WebSocket connected to direct conversation %s; active=%s",
            conversation_id,
            len(self._connections[conversation_id]),
        )

    def disconnect(self, conversation_id: UUID, websocket: WebSocket) -> None:
        connections = self._connections.get(conversation_id)
        if connections is None:
            return

        connections.discard(websocket)
        if not connections:
            self._connections.pop(conversation_id, None)
        logger.info("WebSocket disconnected from direct conversation %s; active=%s", conversation_id, len(connections))

    async def broadcast_to_conversation(self, conversation_id: UUID, event: dict[str, object]) -> None:
        # TODO: Use Valkey pub/sub or another broker before running multiple backend instances.
        connections = list(self._connections.get(conversation_id, set()))
        for websocket in connections:
            try:
                await websocket.send_json(event)
            except RuntimeError:
                self.disconnect(conversation_id, websocket)


direct_websocket_manager = DirectWebSocketManager()


class UserWebSocketManager:
    def __init__(self) -> None:
        self._connections: dict[UUID, set[WebSocket]] = defaultdict(set)

    async def connect_user(self, user_id: UUID, websocket: WebSocket) -> None:
        await websocket.accept()
        self._connections[user_id].add(websocket)
        logger.info("WebSocket connected to user %s; active=%s", user_id, len(self._connections[user_id]))

    def disconnect_user(self, user_id: UUID, websocket: WebSocket) -> None:
        connections = self._connections.get(user_id)
        if connections is None:
            return

        connections.discard(websocket)
        if not connections:
            self._connections.pop(user_id, None)
        logger.info("WebSocket disconnected from user %s; active=%s", user_id, len(connections))

    async def broadcast_to_user(self, user_id: UUID, event: dict[str, object]) -> None:
        # TODO: Use Valkey pub/sub or another broker before running multiple backend instances.
        connections = list(self._connections.get(user_id, set()))
        for websocket in connections:
            try:
                await websocket.send_json(event)
            except RuntimeError:
                self.disconnect_user(user_id, websocket)


user_websocket_manager = UserWebSocketManager()
