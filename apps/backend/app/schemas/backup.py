from datetime import datetime
from typing import Literal

from pydantic import BaseModel, Field


BackupType = Literal["manual", "scheduled", "pre_upgrade", "unknown"]
VerificationStatus = Literal["not_requested", "pending", "passed", "failed", "unknown"]
OffsiteStatus = Literal["not_configured", "copied", "skipped_not_mounted", "failed", "unknown"]


class BackupItemPublic(BaseModel):
    backup_id: str = Field(pattern=r"^officechat-backup-[0-9]{8}-[0-9]{6}Z$")
    created_at: datetime | None
    backup_type: BackupType
    size_bytes: int | None = Field(default=None, ge=0)
    verification_status: VerificationStatus
    verified_at: datetime | None
    offsite_status: OffsiteStatus
    officechat_version: str | None
    build_sha: str | None
    alembic_revision: str | None
    postgresql_version: str | None
    pre_upgrade: bool
    protected: bool
    warnings: list[str] = Field(default_factory=list, max_length=50)
    components: list[str] = Field(default_factory=list, max_length=100)


class BackupPagePublic(BaseModel):
    items: list[BackupItemPublic]
    page: int = Field(ge=1)
    limit: int = Field(ge=1, le=100)
    total: int = Field(ge=0)
    has_next: bool


class BackupRunPublic(BaseModel):
    timestamp: datetime | None
    success: bool | None
    backup_id: str | None = Field(default=None, pattern=r"^officechat-backup-[0-9]{8}-[0-9]{6}Z$")
    backup_size_bytes: int | None = Field(default=None, ge=0)
    duration_seconds: int | None = Field(default=None, ge=0)
    offsite_status: OffsiteStatus
    verification_status: VerificationStatus
    last_error: str | None


class BackupCapacityPublic(BaseModel):
    total_bytes: int | None = Field(default=None, ge=0)
    used_bytes: int | None = Field(default=None, ge=0)
    free_bytes: int | None = Field(default=None, ge=0)
    usage_percent: float | None = Field(default=None, ge=0, le=100)


class BackupTimerPublic(BaseModel):
    installed: bool
    enabled: bool
    active: bool
    next_run_at: datetime | None
    last_trigger_at: datetime | None
    unit_name: Literal["officechat-backup.timer"]


class BackupRetentionPublic(BaseModel):
    daily: int | None = Field(default=None, ge=0)
    weekly: int | None = Field(default=None, ge=0)
    monthly: int | None = Field(default=None, ge=0)


class BackupOffsitePublic(BaseModel):
    configured: bool
    required: bool
    status: OffsiteStatus


class BackupStatusPublic(BaseModel):
    agent_status: Literal["available", "unavailable"]
    backup_health: Literal["healthy", "degraded", "failed", "never_run", "unknown"]
    current_result: Literal["success", "failure", "unknown"]
    last_run: BackupRunPublic | None
    last_success: BackupRunPublic | None
    backup_root_capacity: BackupCapacityPublic
    timer: BackupTimerPublic
    retention: BackupRetentionPublic
    offsite: BackupOffsitePublic
    warnings: list[str] = Field(default_factory=list, max_length=50)
    error_code: str | None = None
