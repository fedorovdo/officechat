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


class DiscussionWebSocketManager:
    def __init__(self) -> None:
        self._connections: dict[UUID, set[WebSocket]] = defaultdict(set)
        self._connection_users: dict[UUID, dict[WebSocket, UUID]] = defaultdict(dict)

    async def connect(self, discussion_id: UUID, user_id: UUID, websocket: WebSocket) -> None:
        await websocket.accept()
        self._connections[discussion_id].add(websocket)
        self._connection_users[discussion_id][websocket] = user_id
        logger.info(
            "WebSocket connected to discussion %s; active=%s",
            discussion_id,
            len(self._connections[discussion_id]),
        )

    def disconnect(self, discussion_id: UUID, websocket: WebSocket) -> None:
        connections = self._connections.get(discussion_id)
        if connections is None:
            return

        connections.discard(websocket)
        connection_users = self._connection_users.get(discussion_id)
        if connection_users is not None:
            connection_users.pop(websocket, None)
        if not connections:
            self._connections.pop(discussion_id, None)
            self._connection_users.pop(discussion_id, None)
        logger.info("WebSocket disconnected from discussion %s; active=%s", discussion_id, len(connections))

    async def disconnect_user(self, discussion_id: UUID, user_id: UUID) -> None:
        connection_users = self._connection_users.get(discussion_id, {})
        for websocket, connected_user_id in list(connection_users.items()):
            if connected_user_id != user_id:
                continue
            await websocket.close(code=1008)
            self.disconnect(discussion_id, websocket)

    async def broadcast_to_discussion(self, discussion_id: UUID, event: dict[str, object]) -> None:
        # TODO: Use Valkey pub/sub or another broker before running multiple backend instances.
        connections = list(self._connections.get(discussion_id, set()))
        for websocket in connections:
            try:
                await websocket.send_json(event)
            except RuntimeError:
                self.disconnect(discussion_id, websocket)


discussion_websocket_manager = DiscussionWebSocketManager()


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
