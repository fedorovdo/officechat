import logging

from starlette.responses import JSONResponse
from starlette.types import ASGIApp, Receive, Scope, Send

logger = logging.getLogger("uvicorn.error")


class UnexpectedErrorMiddleware:
    def __init__(self, app: ASGIApp) -> None:
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        try:
            await self.app(scope, receive, send)
        except Exception:
            if scope["type"] != "http":
                raise
            logger.exception(
                "Unhandled API error for %s %s",
                scope.get("method", "UNKNOWN"),
                scope.get("path", ""),
            )
            response = JSONResponse(status_code=500, content={"detail": "Internal server error"})
            await response(scope, receive, send)
