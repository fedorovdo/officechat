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
