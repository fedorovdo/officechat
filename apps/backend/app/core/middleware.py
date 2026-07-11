import logging
import uuid

from starlette.middleware.base import BaseHTTPMiddleware, RequestResponseEndpoint
from starlette.requests import Request
from starlette.responses import Response
from starlette.responses import JSONResponse
from starlette.types import ASGIApp, Receive, Scope, Send

logger = logging.getLogger("uvicorn.error")


class RequestIdMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request: Request, call_next: RequestResponseEndpoint) -> Response:
        request_id = str(uuid.uuid4())
        request.state.request_id = request_id
        response = await call_next(request)
        response.headers["X-Request-ID"] = request_id
        return response


class UnexpectedErrorMiddleware:
    def __init__(self, app: ASGIApp) -> None:
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        try:
            await self.app(scope, receive, send)
        except Exception:
            if scope["type"] != "http":
                raise
            request_id = scope.get("state", {}).get("request_id")
            logger.exception(
                "Unhandled API error for %s %s request_id=%s",
                scope.get("method", "UNKNOWN"),
                scope.get("path", ""),
                request_id,
            )
            content = {"detail": "Internal server error"}
            if request_id:
                content["request_id"] = request_id
            response = JSONResponse(status_code=500, content=content)
            if request_id:
                response.headers["X-Request-ID"] = request_id
            await response(scope, receive, send)
