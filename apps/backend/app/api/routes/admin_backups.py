import re
from typing import Annotated

from fastapi import APIRouter, Depends, Query
from fastapi.responses import JSONResponse
from pydantic import ValidationError

from app.api.deps import require_superadmin_user
from app.models.user import User
from app.schemas.backup import (
    BackupCapacityPublic,
    BackupItemPublic,
    BackupOffsitePublic,
    BackupPagePublic,
    BackupRetentionPublic,
    BackupStatusPublic,
    BackupTimerPublic,
)
from app.services.backup_agent import (
    BackupAgentClient,
    BackupAgentProtocolError,
    BackupAgentRemoteError,
    BackupAgentUnavailableError,
    get_backup_agent_client,
)


router = APIRouter()
BACKUP_ID_PATTERN = re.compile(r"^officechat-backup-[0-9]{8}-[0-9]{6}Z$")


def api_error(status_code: int, code: str, detail: str) -> JSONResponse:
    return JSONResponse(status_code=status_code, content={"detail": detail, "code": code})


def unavailable_status() -> BackupStatusPublic:
    return BackupStatusPublic(
        agent_status="unavailable",
        backup_health="unknown",
        current_result="unknown",
        last_run=None,
        last_success=None,
        backup_root_capacity=BackupCapacityPublic(),
        timer=BackupTimerPublic(
            installed=False,
            enabled=False,
            active=False,
            next_run_at=None,
            last_trigger_at=None,
            unit_name="officechat-backup.timer",
        ),
        retention=BackupRetentionPublic(),
        offsite=BackupOffsitePublic(configured=False, required=False, status="unknown"),
        warnings=["BACKUP_AGENT_UNAVAILABLE"],
        error_code="BACKUP_AGENT_UNAVAILABLE",
    )


@router.get("/status", response_model=BackupStatusPublic)
async def get_backup_status(
    _: Annotated[User, Depends(require_superadmin_user)],
    client: Annotated[BackupAgentClient, Depends(get_backup_agent_client)],
) -> BackupStatusPublic:
    try:
        return BackupStatusPublic.model_validate(await client.request("status"))
    except (BackupAgentUnavailableError, BackupAgentProtocolError, BackupAgentRemoteError, ValidationError):
        return unavailable_status()


def parse_pagination(page: str, limit: str) -> tuple[int, int] | JSONResponse:
    try:
        parsed_page = int(page)
        parsed_limit = int(limit)
    except ValueError:
        return api_error(400, "INVALID_PAGINATION", "Backup pagination is invalid")
    if str(parsed_page) != page.strip() or str(parsed_limit) != limit.strip() or parsed_page < 1 or not 1 <= parsed_limit <= 100:
        return api_error(400, "INVALID_PAGINATION", "Backup pagination is invalid")
    return parsed_page, parsed_limit


@router.get("", response_model=BackupPagePublic)
async def get_backups(
    _: Annotated[User, Depends(require_superadmin_user)],
    client: Annotated[BackupAgentClient, Depends(get_backup_agent_client)],
    page: Annotated[str, Query()] = "1",
    limit: Annotated[str, Query()] = "25",
) -> BackupPagePublic | JSONResponse:
    pagination = parse_pagination(page, limit)
    if isinstance(pagination, JSONResponse):
        return pagination
    parsed_page, parsed_limit = pagination
    try:
        data = await client.request("list_backups", {"page": parsed_page, "limit": parsed_limit})
        return BackupPagePublic.model_validate(data)
    except BackupAgentUnavailableError:
        return api_error(503, "BACKUP_AGENT_UNAVAILABLE", "Backup agent is unavailable")
    except (BackupAgentProtocolError, ValidationError):
        return api_error(502, "BACKUP_AGENT_INVALID_RESPONSE", "Backup agent returned invalid metadata")
    except BackupAgentRemoteError as exc:
        status_code = 503 if exc.code == "BACKUP_ROOT_UNAVAILABLE" else 502
        return api_error(status_code, exc.code, "Backup metadata is unavailable")


@router.get("/{backup_id}", response_model=BackupItemPublic)
async def get_backup(
    backup_id: str,
    _: Annotated[User, Depends(require_superadmin_user)],
    client: Annotated[BackupAgentClient, Depends(get_backup_agent_client)],
) -> BackupItemPublic | JSONResponse:
    if len(backup_id) > 64 or not BACKUP_ID_PATTERN.fullmatch(backup_id):
        return api_error(400, "INVALID_BACKUP_ID", "Backup identifier is invalid")
    try:
        data = await client.request("get_backup", {"backup_id": backup_id})
        return BackupItemPublic.model_validate(data)
    except BackupAgentUnavailableError:
        return api_error(503, "BACKUP_AGENT_UNAVAILABLE", "Backup agent is unavailable")
    except BackupAgentRemoteError as exc:
        if exc.code == "BACKUP_NOT_FOUND":
            return api_error(404, exc.code, "Backup was not found")
        return api_error(502, exc.code, "Backup metadata is unavailable")
    except (BackupAgentProtocolError, ValidationError):
        return api_error(502, "BACKUP_AGENT_INVALID_RESPONSE", "Backup agent returned invalid metadata")
