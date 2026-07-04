import logging
import unittest
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch
from uuid import uuid4

import jwt
from fastapi import HTTPException

from app.api.deps import get_current_user
from app.api.routes.ws import WS_FORBIDDEN, WS_UNAUTHORIZED, group_messages_websocket
from app.core.config import Settings, settings
from app.core.logging import SensitiveDataFilter, redact_sensitive_query_parameters
from app.main import create_app
from app.services.security import create_access_token


class FakeWebSocket:
    def __init__(self):
        self.close_code = None

    async def close(self, code):
        self.close_code = code


class AuthenticationTests(unittest.IsolatedAsyncioTestCase):
    def request(self):
        return SimpleNamespace(client=None, state=SimpleNamespace(request_id="test-request"), url=SimpleNamespace(path="/test"), method="GET")

    async def test_invalid_jwt_returns_401(self):
        with patch("app.api.deps.record_audit_event_best_effort", AsyncMock()):
            with self.assertRaises(HTTPException) as raised:
                await get_current_user(self.request(), "not-a-jwt", AsyncMock())
        self.assertEqual(raised.exception.status_code, 401)

    async def test_expired_jwt_returns_401(self):
        token = jwt.encode(
            {"sub": str(uuid4()), "exp": datetime.now(timezone.utc) - timedelta(seconds=1)},
            settings.app_secret_key,
            algorithm="HS256",
        )
        with patch("app.api.deps.record_audit_event_best_effort", AsyncMock()):
            with self.assertRaises(HTTPException) as raised:
                await get_current_user(self.request(), token, AsyncMock())
        self.assertEqual(raised.exception.status_code, 401)

    async def test_valid_jwt_loads_active_user(self):
        user = SimpleNamespace(id=uuid4(), username="dmitrii", role="user", is_active=True)
        token = create_access_token(user.id, user.username, user.role)
        with patch("app.api.deps.get_user_by_id", AsyncMock(return_value=user)):
            result = await get_current_user(self.request(), token, AsyncMock())
        self.assertIs(result, user)

    async def test_websocket_invalid_token_closes_with_4401(self):
        websocket = FakeWebSocket()
        with patch("app.api.routes.ws.authorize_group_websocket", AsyncMock(return_value=(None, WS_UNAUTHORIZED))):
            await group_messages_websocket(websocket, uuid4(), "invalid")
        self.assertEqual(websocket.close_code, 4401)

    async def test_websocket_forbidden_access_closes_with_4403(self):
        websocket = FakeWebSocket()
        with patch("app.api.routes.ws.authorize_group_websocket", AsyncMock(return_value=(None, WS_FORBIDDEN))):
            await group_messages_websocket(websocket, uuid4(), "valid-but-forbidden")
        self.assertEqual(websocket.close_code, 4403)


class SensitiveLogTests(unittest.TestCase):
    def test_sensitive_query_parameters_are_redacted(self):
        value = (
            'WebSocket /api/ws/me?token=jwt-value&ticket=secret&access_token=second'
            '&authorization=third&group=alerts'
        )
        sanitized = redact_sensitive_query_parameters(value)
        self.assertNotIn("jwt-value", sanitized)
        self.assertNotIn("secret", sanitized)
        self.assertNotIn("second", sanitized)
        self.assertNotIn("third", sanitized)
        self.assertIn("group=alerts", sanitized)
        self.assertEqual(sanitized.count("[REDACTED]"), 4)

    def test_bot_webhook_token_path_is_redacted(self):
        sanitized = redact_sensitive_query_parameters("POST /api/bots/incoming/complete-bot-token")
        self.assertEqual(sanitized, "POST /api/bots/incoming/[REDACTED]")

    def test_logging_filter_sanitizes_formatted_arguments(self):
        record = logging.LogRecord(
            "uvicorn.access",
            logging.INFO,
            __file__,
            1,
            '%s - "WebSocket %s"',
            ("client", "/api/ws/me?token=complete-jwt&view=all"),
            None,
        )
        SensitiveDataFilter().filter(record)
        rendered = record.getMessage()
        self.assertIn("token=[REDACTED]", rendered)
        self.assertIn("view=all", rendered)
        self.assertNotIn("complete-jwt", rendered)


class ConfigurationTests(unittest.TestCase):
    def test_production_rejects_development_secret(self):
        with self.assertRaises(ValueError):
            Settings(environment="production", app_secret_key="change-me-in-production")


class ErrorResponseTests(unittest.IsolatedAsyncioTestCase):
    async def test_unexpected_error_response_keeps_cors_headers(self):
        app = create_app()

        @app.get("/__test_unexpected_error")
        async def fail():
            raise RuntimeError("test failure")

        sent = []
        request_sent = False

        async def receive():
            nonlocal request_sent
            if not request_sent:
                request_sent = True
                return {"type": "http.request", "body": b"", "more_body": False}
            return {"type": "http.disconnect"}

        async def send(message):
            sent.append(message)

        scope = {
            "type": "http",
            "asgi": {"version": "3.0"},
            "http_version": "1.1",
            "method": "GET",
            "scheme": "http",
            "path": "/__test_unexpected_error",
            "raw_path": b"/__test_unexpected_error",
            "query_string": b"",
            "root_path": "",
            "headers": [(b"host", b"testserver"), (b"origin", b"http://localhost:3100")],
            "client": ("127.0.0.1", 1234),
            "server": ("testserver", 80),
        }

        await app(scope, receive, send)
        start = next(message for message in sent if message["type"] == "http.response.start")
        headers = dict(start["headers"])
        self.assertEqual(start["status"], 500)
        self.assertEqual(headers.get(b"access-control-allow-origin"), b"http://localhost:3100")
        self.assertRegex(headers.get(b"x-request-id", b"").decode(), r"^[0-9a-f-]{36}$")


if __name__ == "__main__":
    unittest.main()
