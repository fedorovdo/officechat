import asyncio
import json
import uuid
from typing import Any

from app.core.config import settings


PROTOCOL_VERSION = 1
KNOWN_AGENT_ERROR_CODES = {
    "BACKUP_NOT_FOUND",
    "BACKUP_INCOMPLETE",
    "BACKUP_ROOT_UNAVAILABLE",
    "INTERNAL_ERROR",
    "INVALID_JOB_ID",
    "INVALID_ACTOR",
    "INVALID_BACKUP_ID",
    "INVALID_PAGINATION",
    "INVALID_PARAMS",
    "INVALID_REQUEST",
    "INVALID_REQUEST_ID",
    "PROTOCOL_MISMATCH",
    "JOB_CONFLICT",
    "JOB_NOT_FOUND",
    "JOB_EXECUTION_FAILED",
    "JOB_START_FAILED",
    "JOB_RESULT_UNAVAILABLE",
    "AUDIT_CLAIM_INVALID",
    "AUDIT_BACKLOG_FULL",
    "AUDIT_JOB_NOT_TERMINAL",
    "RESPONSE_TOO_LARGE",
    "UNKNOWN_OPERATION",
}


class BackupAgentUnavailableError(RuntimeError):
    pass


class BackupAgentProtocolError(RuntimeError):
    pass


class BackupAgentTimeoutError(BackupAgentUnavailableError):
    pass


class BackupAgentRemoteError(RuntimeError):
    def __init__(self, code: str) -> None:
        super().__init__(code)
        self.code = code


class BackupAgentClient:
    def __init__(
        self,
        socket_path: str,
        *,
        connect_timeout: float = 2.0,
        read_timeout: float = 5.0,
        max_response_bytes: int = 1_048_576,
    ) -> None:
        self.socket_path = socket_path
        self.connect_timeout = connect_timeout
        self.read_timeout = read_timeout
        self.max_response_bytes = max_response_bytes

    async def request(self, operation: str, params: dict[str, Any] | None = None) -> dict[str, Any]:
        request_id = str(uuid.uuid4())
        request = {
            "protocol_version": PROTOCOL_VERSION,
            "request_id": request_id,
            "operation": operation,
            "params": params or {},
        }
        writer: asyncio.StreamWriter | None = None
        try:
            reader, writer = await asyncio.wait_for(
                asyncio.open_unix_connection(self.socket_path, limit=self.max_response_bytes + 1),
                timeout=self.connect_timeout,
            )
            writer.write((json.dumps(request, separators=(",", ":")) + "\n").encode("utf-8"))
            await asyncio.wait_for(writer.drain(), timeout=self.connect_timeout)
            try:
                raw = await asyncio.wait_for(reader.readline(), timeout=self.read_timeout)
            except asyncio.TimeoutError as exc:
                raise BackupAgentTimeoutError("Backup agent response timed out") from exc
            except ValueError as exc:
                raise BackupAgentProtocolError("Backup agent response is too large") from exc
        except BackupAgentTimeoutError:
            raise
        except (FileNotFoundError, ConnectionRefusedError, asyncio.TimeoutError, OSError) as exc:
            raise BackupAgentUnavailableError("Backup agent is unavailable") from exc
        finally:
            if writer is not None:
                writer.close()
                try:
                    await writer.wait_closed()
                except OSError:
                    pass
        if not raw or not raw.endswith(b"\n") or len(raw) > self.max_response_bytes:
            raise BackupAgentProtocolError("Backup agent returned an invalid response")
        try:
            response = json.loads(raw.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise BackupAgentProtocolError("Backup agent returned invalid JSON") from exc
        if not isinstance(response, dict):
            raise BackupAgentProtocolError("Backup agent returned an invalid response")
        if response.get("protocol_version") != PROTOCOL_VERSION or response.get("request_id") != request_id:
            raise BackupAgentProtocolError("Backup agent response validation failed")
        if response.get("ok") is False:
            error = response.get("error")
            raw_code = error.get("code") if isinstance(error, dict) else None
            code = raw_code if raw_code in KNOWN_AGENT_ERROR_CODES else "BACKUP_AGENT_ERROR"
            raise BackupAgentRemoteError(code)
        if response.get("ok") is not True or not isinstance(response.get("data"), dict):
            raise BackupAgentProtocolError("Backup agent returned an invalid response")
        return response["data"]


def get_backup_agent_client() -> BackupAgentClient:
    return BackupAgentClient(
        settings.backup_agent_socket,
        connect_timeout=settings.backup_agent_connect_timeout_seconds,
        read_timeout=settings.backup_agent_read_timeout_seconds,
        max_response_bytes=settings.backup_agent_max_response_bytes,
    )
