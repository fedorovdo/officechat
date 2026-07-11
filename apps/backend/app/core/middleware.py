import logging
import time
import uuid

from starlette.middleware.base import BaseHTTPMiddleware, RequestResponseEndpoint
from starlette.requests import Request
from starlette.responses import Response
from starlette.responses import JSONResponse
from starlette.types import ASGIApp, Receive, Scope, Send

logger = logging.getLogger("uvicorn.error")
access_logger = logger
SLOW_REQUEST_THRESHOLD_SECONDS = 1.0


class RequestIdMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request: Request, call_next: RequestResponseEndpoint) -> Response:
        request_id = request.headers.get("X-Request-ID") or str(uuid.uuid4())
        request.state.request_id = request_id
        start = time.perf_counter()
        response = await call_next(request)
        duration_ms = (time.perf_counter() - start) * 1000
        response.headers["X-Request-ID"] = request_id
        path = request.url.path
        actor_user_id = getattr(request.state, "actor_user_id", None)
        access_logger.info(
            "request method=%s path=%s status=%s duration_ms=%.1f request_id=%s actor_user_id=%s",
            request.method,
            path,
            response.status_code,
            duration_ms,
            request_id,
            actor_user_id or "-",
        )
        if duration_ms >= SLOW_REQUEST_THRESHOLD_SECONDS * 1000:
            logger.warning(
                "slow_request method=%s path=%s status=%s duration_ms=%.1f request_id=%s actor_user_id=%s",
                request.method,
                path,
                response.status_code,
                duration_ms,
                request_id,
                actor_user_id or "-",
            )
        return response


class SecurityHeadersMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request: Request, call_next: RequestResponseEndpoint) -> Response:
        response = await call_next(request)
        response.headers.setdefault("X-Content-Type-Options", "nosniff")
        response.headers.setdefault("Referrer-Policy", "strict-origin-when-cross-origin")
        response.headers.setdefault("X-Frame-Options", "DENY")
        response.headers.setdefault("Permissions-Policy", "camera=(), microphone=(), geolocation=()")
        if request.url.scheme == "https":
            response.headers.setdefault("Strict-Transport-Security", "max-age=31536000; includeSubDomains")
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
            content = {"detail": "Internal server error", "code": "internal_server_error"}
            if request_id:
                content["request_id"] = request_id
            response = JSONResponse(status_code=500, content=content)
            if request_id:
                response.headers["X-Request-ID"] = request_id
            await response(scope, receive, send)
