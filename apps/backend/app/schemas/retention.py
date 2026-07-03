from datetime import datetime
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, model_validator


class RetentionSettingsUpdate(BaseModel):
    retention_enabled: bool | None = None
    active_history_days: int | None = Field(default=None, ge=0, le=36500)
    archive_enabled: bool | None = None
    attachment_retention_days: int | None = Field(default=None, ge=0, le=36500)
    delete_archived_after_days: int | None = Field(default=None, ge=1, le=36500)
    cleanup_batch_size: int | None = Field(default=None, ge=1, le=5000)
    cleanup_interval_hours: int | None = Field(default=None, ge=1, le=8760)

    @model_validator(mode="after")
    def reject_empty_update(self):
        if not self.model_fields_set:
            raise ValueError("At least one retention setting is required")
        required_fields = {
            "retention_enabled",
            "active_history_days",
            "archive_enabled",
            "cleanup_batch_size",
            "cleanup_interval_hours",
        }
        for field_name in self.model_fields_set & required_fields:
            if getattr(self, field_name) is None:
                raise ValueError(f"{field_name} cannot be null")
        return self


class RetentionSettingsPublic(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    retention_enabled: bool
    active_history_days: int
    archive_enabled: bool
    attachment_retention_days: int | None
    delete_archived_after_days: int | None
    cleanup_batch_size: int
    cleanup_interval_hours: int
    last_cleanup_started_at: datetime | None
    last_cleanup_finished_at: datetime | None
    last_cleanup_status: str | None
    last_cleanup_summary: dict | None
    updated_at: datetime
    updated_by_user_id: UUID | None


class RetentionRunRequest(BaseModel):
    confirm: bool = False


class RetentionSummary(BaseModel):
    group_messages_archived: int = 0
    direct_messages_archived: int = 0
    discussion_messages_archived: int = 0
    attachments_deleted: int = 0
    files_missing: int = 0
    errors: list[str] = Field(default_factory=list)

    @property
    def messages_to_archive(self) -> int:
        return self.group_messages_archived + self.direct_messages_archived + self.discussion_messages_archived


class RetentionRunResult(BaseModel):
    dry_run: bool
    status: str
    summary: RetentionSummary


class StorageMessageCounts(BaseModel):
    active: int
    archived: int
    soft_deleted: int


class StorageStats(BaseModel):
    uploads_total_bytes: int
    avatar_bytes: int
    group_attachment_bytes: int
    direct_attachment_bytes: int
    discussion_attachment_bytes: int
    attachment_count: int
    missing_file_count: int
    message_counts: StorageMessageCounts
    oldest_active_message_at: datetime | None
    oldest_archived_message_at: datetime | None
