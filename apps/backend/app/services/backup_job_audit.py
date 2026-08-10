import logging
from datetime import datetime
from typing import Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, model_validator
from sqlalchemy import select

from app.db.session import AsyncSessionLocal
from app.models.audit import AuditEvent
from app.models.user import User
from app.services.audit import record_audit_event
from app.services.backup_agent import (
    BackupAgentClient,
    BackupAgentProtocolError,
    BackupAgentRemoteError,
    BackupAgentUnavailableError,
)


logger = logging.getLogger(__name__)
MAX_RECONCILIATIONS_PER_REQUEST = 10


class TerminalAuditJob(BaseModel):
    model_config = ConfigDict(extra="forbid")

    job_id: UUID
    operation: Literal["create_backup", "verify_backup"]
    state: Literal["succeeded", "failed", "interrupted"]
    phase: str = Field(max_length=64)
    backup_id: str | None = Field(default=None, pattern=r"^officechat-backup-[0-9]{8}-[0-9]{6}Z$")
    requested_at: datetime
    started_at: datetime | None
    finished_at: datetime | None
    success: bool
    exit_code: int | None
    safe_message: str = Field(max_length=300)
    last_error: str | None = Field(default=None, max_length=64)
    requested_by_user_id: UUID | None
    requested_by_login: str | None = Field(default=None, min_length=1, max_length=64)


class TerminalAuditClaim(BaseModel):
    model_config = ConfigDict(extra="forbid")

    claim_id: UUID | None
    job: TerminalAuditJob | None

    @model_validator(mode="after")
    def validate_pair(self) -> "TerminalAuditClaim":
        if (self.claim_id is None) != (self.job is None):
            raise ValueError("Audit claim and job must both be present or absent")
        return self


def terminal_event_type(operation: str) -> str:
    return "backup.manual.completed" if operation == "create_backup" else "backup.verify.completed"


async def persist_terminal_audit(job: TerminalAuditJob) -> bool:
    event_type = terminal_event_type(job.operation)
    job_id = str(job.job_id)
    async with AsyncSessionLocal() as session:
        existing = await session.scalar(
            select(AuditEvent.id).where(
                AuditEvent.category == "backup",
                AuditEvent.event_type == event_type,
                AuditEvent.target_type == "backup_job",
                AuditEvent.target_id == job_id,
            )
        )
        if existing is not None:
            return False
        actor_user_id = None
        if job.requested_by_user_id is not None:
            actor_user_id = await session.scalar(
                select(User.id).where(User.id == job.requested_by_user_id)
            )
        await record_audit_event(
            session,
            event_type=event_type,
            category="backup",
            action=job.operation,
            status="success" if job.success else "failure",
            actor_user_id=actor_user_id,
            actor_username=job.requested_by_login or "unknown",
            target_type="backup_job",
            target_id=job_id,
            target_label=job.backup_id or job_id,
            details={
                "operation": job.operation,
                "job_id": job_id,
                "backup_id": job.backup_id,
                "result": "success" if job.success else "failure",
                "requested_by_user_id": str(job.requested_by_user_id) if job.requested_by_user_id else None,
                "requested_by_login": job.requested_by_login,
            },
            error_code=job.last_error,
        )
        await session.commit()
        return True


async def _release_claim(client: BackupAgentClient, claim: TerminalAuditClaim) -> None:
    if claim.claim_id is None or claim.job is None:
        return
    try:
        await client.request(
            "release_job_audit",
            {"job_id": str(claim.job.job_id), "claim_id": str(claim.claim_id)},
        )
    except (BackupAgentUnavailableError, BackupAgentProtocolError, BackupAgentRemoteError):
        logger.warning("Could not release backup audit claim for job_id=%s", claim.job.job_id)


async def reconcile_backup_job_audits(client: BackupAgentClient) -> None:
    for _ in range(MAX_RECONCILIATIONS_PER_REQUEST):
        try:
            claim = TerminalAuditClaim.model_validate(await client.request("claim_job_audit"))
        except (BackupAgentUnavailableError, BackupAgentProtocolError, BackupAgentRemoteError, ValueError):
            logger.warning("Backup terminal audit reconciliation is temporarily unavailable")
            return
        if claim.job is None or claim.claim_id is None:
            return
        try:
            await persist_terminal_audit(claim.job)
        except Exception:
            logger.exception("Backup terminal audit commit failed for job_id=%s", claim.job.job_id)
            await _release_claim(client, claim)
            return
        try:
            await client.request(
                "complete_job_audit",
                {"job_id": str(claim.job.job_id), "claim_id": str(claim.claim_id)},
            )
        except (BackupAgentUnavailableError, BackupAgentProtocolError, BackupAgentRemoteError):
            logger.warning("Backup terminal audit acknowledgement failed for job_id=%s", claim.job.job_id)
            return
