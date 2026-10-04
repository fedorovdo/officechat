from datetime import datetime
from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field


BackupType = Literal["manual", "scheduled", "pre_upgrade", "pre_storage_change", "unknown"]
VerificationStatus = Literal["not_requested", "pending", "passed", "failed", "unknown"]
OffsiteStatus = Literal["not_configured", "copied", "skipped_not_mounted", "failed", "unknown"]
BackupJobOperation = Literal["create_backup", "verify_backup"]
BackupJobState = Literal["queued", "running", "verifying", "succeeded", "failed", "interrupted"]


class LocalBackupDestination(BaseModel):
    model_config = ConfigDict(extra="forbid")
    kind: Literal["local", "unchanged", "reconnect"]


class NfsBackupDestination(BaseModel):
    model_config = ConfigDict(extra="forbid")
    kind: Literal["nfs"]
    host: str = Field(min_length=1, max_length=253, pattern=r"^[a-zA-Z0-9][a-zA-Z0-9.-]*[a-zA-Z0-9]$|^[a-zA-Z0-9]$")
    export: str = Field(min_length=2, max_length=255, pattern=r"^/(?:[a-zA-Z0-9_.-]+/?)+$")
    version: Literal["3", "4.1", "4.2"]
    require_offsite: bool = False
    replace_existing: bool = False


class SmbBackupDestination(BaseModel):
    model_config = ConfigDict(extra="forbid")
    kind: Literal["smb"]
    host: str = Field(min_length=1, max_length=253, pattern=r"^[a-zA-Z0-9][a-zA-Z0-9.-]*[a-zA-Z0-9]$|^[a-zA-Z0-9]$")
    share: str = Field(min_length=1, max_length=80, pattern=r"^[a-zA-Z0-9][a-zA-Z0-9_.$-]*$")
    directory: str = Field(default="", max_length=255, pattern=r"^(?:|[a-zA-Z0-9_][a-zA-Z0-9_.-]*(?:/[a-zA-Z0-9_][a-zA-Z0-9_.-]*)*)$")
    domain: str = Field(max_length=128)
    username: str = Field(min_length=1, max_length=128)
    password: str = Field(min_length=1, max_length=512)
    require_offsite: bool = False
    replace_existing: bool = False


class BackupScheduleUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid")
    enabled: bool
    days: list[Literal["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]] = Field(min_length=1, max_length=7)
    time: str = Field(pattern=r"^(?:[01][0-9]|2[0-3]):[0-5][0-9]$")


class BackupSettingsUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid")
    destination: Annotated[LocalBackupDestination | NfsBackupDestination | SmbBackupDestination, Field(discriminator="kind")]
    schedule: BackupScheduleUpdate


class BackupSettingsJobPublic(BaseModel):
    request_id: str = Field(pattern=r"^[0-9a-f-]{36}$")
    state: Literal["queued", "running", "succeeded", "failed"]
    requested_at: datetime
    finished_at: datetime | None = None
    error_code: Literal["MOUNT_HELPER_MISSING", "MAINTENANCE_BUSY", "DESTINATION_READ_FAILED", "SETTINGS_APPLY_FAILED", "STORAGE_MIGRATION_FAILED", "STORAGE_ROLLBACK_FAILED"] | None = None
    phase: Literal["protected_backup", "connecting", "copying", "rolling_back", "completed"] | None = None
    backup_id: str | None = Field(default=None, pattern=r"^officechat-backup-[0-9]{8}-[0-9]{6}Z$")


class BackupSettingsPublic(BaseModel):
    destination: dict[str, str | bool]
    schedule: BackupScheduleUpdate
    next_run_at: datetime | None = None


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
    mounted: bool | None = None


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


class BackupJobCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    operation: Literal["create_backup"]


class BackupJobPublic(BaseModel):
    job_id: str = Field(pattern=r"^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$")
    operation: BackupJobOperation
    state: BackupJobState
    phase: str = Field(max_length=64)
    backup_id: str | None = Field(default=None, pattern=r"^officechat-backup-[0-9]{8}-[0-9]{6}Z$")
    requested_at: datetime
    started_at: datetime | None
    finished_at: datetime | None
    success: bool | None
    exit_code: int | None
    safe_message: str = Field(max_length=300)
    last_error: str | None = Field(default=None, max_length=64)


class ActiveBackupJobPublic(BaseModel):
    job: BackupJobPublic | None


class RestoreConfirm(BaseModel):
    model_config = ConfigDict(extra="forbid")

    backup_id: str = Field(pattern=r"^officechat-backup-[0-9]{8}-[0-9]{6}Z$")
    challenge: str = Field(min_length=32, max_length=64)
    confirm_hostname: str = Field(min_length=1, max_length=255)
    confirm_backup: str = Field(pattern=r"^officechat-backup-[0-9]{8}-[0-9]{6}Z$")
    reason: str = Field(min_length=20, max_length=1000)


class RestorePreparationPublic(BaseModel):
    challenge: str
    backup_id: str
    hostname: str
    expires_in_seconds: int


class RestoreRequestPublic(BaseModel):
    request_id: str = Field(pattern=r"^[0-9a-f-]{36}$")
    backup_id: str
    hostname: str
    state: Literal["queued", "running", "succeeded", "failed"]
    requested_at: datetime
    started_at: datetime | None
    finished_at: datetime | None
    last_error: str | None


class LatestRestorePublic(BaseModel):
    request: RestoreRequestPublic | None
