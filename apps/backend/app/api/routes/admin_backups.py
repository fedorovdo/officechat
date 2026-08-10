import re
from typing import Annotated

from fastapi import APIRouter, Depends, Query, Request, status
from fastapi.responses import JSONResponse
from pydantic import ValidationError

from app.api.deps import require_superadmin_user
from app.models.user import User
from app.schemas.backup import (
    BackupCapacityPublic,
    ActiveBackupJobPublic,
    BackupJobCreate,
    BackupJobPublic,
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
    BackupAgentTimeoutError,
    BackupAgentUnavailableError,
    get_backup_agent_client,
)
from app.services.audit import record_audit_event_best_effort
from app.services.backup_job_audit import reconcile_backup_job_audits


router = APIRouter()
BACKUP_ID_PATTERN = re.compile(r"^officechat-backup-[0-9]{8}-[0-9]{6}Z$")
JOB_ID_PATTERN = re.compile(
    r"^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"
)


def api_error(status_code: int, code: str, detail: str) -> JSONResponse:
    return JSONResponse(status_code=status_code, content={"detail": detail, "code": code})


async def audit_job_event(
    request: Request,
    actor: User,
    *,
    event_type: str,
    action: str,
    result: str,
    job_id: str | None = None,
    backup_id: str | None = None,
    error_code: str | None = None,
) -> None:
    await record_audit_event_best_effort(
        event_type=event_type,
        category="backup",
        action=action,
        status=result,
        actor=actor,
        target_type="backup_job",
        target_id=job_id,
        target_label=backup_id or job_id,
        details={"operation": action, "job_id": job_id, "backup_id": backup_id, "result": result},
        error_code=error_code,
        request=request,
    )


def job_error(exc: Exception) -> JSONResponse:
    if isinstance(exc, BackupAgentTimeoutError):
        return api_error(504, "BACKUP_AGENT_TIMEOUT", "Backup agent response timed out")
    if isinstance(exc, BackupAgentUnavailableError):
        return api_error(503, "BACKUP_AGENT_UNAVAILABLE", "Backup agent is unavailable")
    if isinstance(exc, BackupAgentRemoteError):
        if exc.code == "JOB_CONFLICT":
            return api_error(409, exc.code, "Another backup operation is already running")
        if exc.code == "AUDIT_BACKLOG_FULL":
            return api_error(503, exc.code, "Backup audit reconciliation is temporarily behind")
        if exc.code in {"BACKUP_NOT_FOUND", "JOB_NOT_FOUND"}:
            return api_error(404, exc.code, "Backup or backup job was not found")
        if exc.code == "BACKUP_INCOMPLETE":
            return api_error(409, exc.code, "Backup is not complete")
        if exc.code in {"INVALID_BACKUP_ID", "INVALID_JOB_ID", "INVALID_PARAMS"}:
            return api_error(400, exc.code, "Backup request is invalid")
        return api_error(502, exc.code, "Backup operation could not be started")
    return api_error(502, "BACKUP_AGENT_INVALID_RESPONSE", "Backup agent returned invalid job metadata")


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
    await reconcile_backup_job_audits(client)
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
    await reconcile_backup_job_audits(client)
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


@router.post("/jobs", response_model=BackupJobPublic, status_code=status.HTTP_202_ACCEPTED)
async def create_backup_job(
    payload: BackupJobCreate,
    request: Request,
    actor: Annotated[User, Depends(require_superadmin_user)],
    client: Annotated[BackupAgentClient, Depends(get_backup_agent_client)],
) -> BackupJobPublic | JSONResponse:
    await audit_job_event(
        request, actor, event_type="backup.manual.requested", action=payload.operation, result="requested"
    )
    try:
        job = BackupJobPublic.model_validate(await client.request(
            "create_backup",
            {"requested_by_user_id": str(actor.id), "requested_by_login": actor.username},
        ))
    except (BackupAgentUnavailableError, BackupAgentProtocolError, BackupAgentRemoteError, ValidationError) as exc:
        error = job_error(exc)
        await audit_job_event(
            request,
            actor,
            event_type="backup.manual.failed",
            action=payload.operation,
            result="failure",
            error_code=exc.code if isinstance(exc, BackupAgentRemoteError) else "BACKUP_AGENT_UNAVAILABLE",
        )
        return error
    await audit_job_event(
        request,
        actor,
        event_type="backup.manual.started",
        action=payload.operation,
        result="started",
        job_id=job.job_id,
    )
    return job


@router.get("/jobs/active", response_model=ActiveBackupJobPublic)
async def get_active_backup_job(
    _: Annotated[User, Depends(require_superadmin_user)],
    client: Annotated[BackupAgentClient, Depends(get_backup_agent_client)],
) -> ActiveBackupJobPublic | JSONResponse:
    await reconcile_backup_job_audits(client)
    try:
        return ActiveBackupJobPublic.model_validate(await client.request("get_active_job"))
    except (BackupAgentUnavailableError, BackupAgentProtocolError, BackupAgentRemoteError, ValidationError) as exc:
        return job_error(exc)


@router.get("/jobs/{job_id}", response_model=BackupJobPublic)
async def get_backup_job(
    job_id: str,
    request: Request,
    actor: Annotated[User, Depends(require_superadmin_user)],
    client: Annotated[BackupAgentClient, Depends(get_backup_agent_client)],
) -> BackupJobPublic | JSONResponse:
    await reconcile_backup_job_audits(client)
    if len(job_id) > 64 or not JOB_ID_PATTERN.fullmatch(job_id):
        return api_error(400, "INVALID_JOB_ID", "Backup job identifier is invalid")
    try:
        job = BackupJobPublic.model_validate(await client.request("get_job", {"job_id": job_id}))
    except (BackupAgentUnavailableError, BackupAgentProtocolError, BackupAgentRemoteError, ValidationError) as exc:
        return job_error(exc)
    return job


@router.post("/{backup_id}/verify", response_model=BackupJobPublic, status_code=status.HTTP_202_ACCEPTED)
async def verify_backup(
    backup_id: str,
    request: Request,
    actor: Annotated[User, Depends(require_superadmin_user)],
    client: Annotated[BackupAgentClient, Depends(get_backup_agent_client)],
) -> BackupJobPublic | JSONResponse:
    if len(backup_id) > 64 or not BACKUP_ID_PATTERN.fullmatch(backup_id):
        return api_error(400, "INVALID_BACKUP_ID", "Backup identifier is invalid")
    await audit_job_event(
        request,
        actor,
        event_type="backup.verify.requested",
        action="verify_backup",
        result="requested",
        backup_id=backup_id,
    )
    try:
        job = BackupJobPublic.model_validate(
            await client.request("verify_backup", {
                "backup_id": backup_id,
                "requested_by_user_id": str(actor.id),
                "requested_by_login": actor.username,
            })
        )
    except (BackupAgentUnavailableError, BackupAgentProtocolError, BackupAgentRemoteError, ValidationError) as exc:
        error = job_error(exc)
        await audit_job_event(
            request,
            actor,
            event_type="backup.verify.failed",
            action="verify_backup",
            result="failure",
            backup_id=backup_id,
        )
        return error
    await audit_job_event(
        request,
        actor,
        event_type="backup.verify.started",
        action="verify_backup",
        result="started",
        job_id=job.job_id,
        backup_id=backup_id,
    )
    return job


@router.get("/{backup_id}", response_model=BackupItemPublic)
async def get_backup(
    backup_id: str,
    _: Annotated[User, Depends(require_superadmin_user)],
    client: Annotated[BackupAgentClient, Depends(get_backup_agent_client)],
) -> BackupItemPublic | JSONResponse:
    await reconcile_backup_job_audits(client)
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
