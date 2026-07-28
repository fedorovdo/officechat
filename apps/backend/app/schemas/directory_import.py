from datetime import datetime
from typing import Any, Literal
from uuid import UUID

from pydantic import (
    BaseModel,
    ConfigDict,
    EmailStr,
    Field,
    ValidationInfo,
    field_validator,
    model_validator,
)

DirectoryImportParserMode = Literal["auto", "table", "legacy_layout"]
DirectoryImportStatus = Literal[
    "draft", "analyzed", "reconciled", "executing", "completed", "failed", "cancelled"
]
DirectoryImportKind = Literal[
    "person", "role", "department_contact", "organization_metadata", "unknown"
]
DirectoryImportAction = Literal["create", "update", "skip"]
DirectoryImportPreviewAction = Literal["create", "skip"]
DirectoryImportMatchStatus = Literal[
    "unmatched", "exact", "probable", "ambiguous", "batch_duplicate", "archived_match"
]
DirectoryImportExecutionStatus = Literal[
    "pending", "created", "updated", "restored", "skipped", "failed"
]
DIRECTORY_IMPORT_TARGET_FIELDS = {
    "display_name",
    "department",
    "position",
    "internal_phone",
    "work_phone",
    "mobile_phone",
    "email",
    "room",
    "location",
    "notes",
}
DIRECTORY_IMPORT_UPDATE_FIELDS = frozenset(DIRECTORY_IMPORT_TARGET_FIELDS)


class DirectoryImportNormalizedData(BaseModel):
    model_config = ConfigDict(extra="forbid")

    display_name: str | None = Field(default=None, max_length=160)
    department: str | None = Field(default=None, max_length=160)
    position: str | None = Field(default=None, max_length=160)
    internal_phone: str | None = Field(default=None, max_length=64)
    work_phone: str | None = Field(default=None, max_length=64)
    mobile_phone: str | None = Field(default=None, max_length=64)
    email: EmailStr | None = None
    room: str | None = Field(default=None, max_length=80)
    location: str | None = Field(default=None, max_length=255)
    notes: str | None = Field(default=None, max_length=2000)

    @field_validator("*")
    @classmethod
    def strip_text(cls, value: str | None, info: ValidationInfo) -> str | None:
        if value is None:
            return None
        normalized = value.strip()
        return normalized or None


class DirectoryImportBatchUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    parser_mode: DirectoryImportParserMode | None = None
    selected_sheet: str | None = Field(default=None, max_length=255)
    column_mapping: dict[str, str] | None = None

    @field_validator("column_mapping")
    @classmethod
    def validate_mapping(cls, value: dict[str, str] | None) -> dict[str, str] | None:
        if value is None:
            return None
        assigned: set[str] = set()
        result: dict[str, str] = {}
        if len(value) > 1000:
            raise ValueError("Directory import column mapping is too large")
        for source, target in value.items():
            if (
                not source.isdigit()
                or int(source) >= 1000
                or target not in DIRECTORY_IMPORT_TARGET_FIELDS
            ):
                raise ValueError("Invalid directory import column mapping")
            if target in assigned:
                raise ValueError("One target field cannot be mapped twice")
            result[str(int(source))] = target
            assigned.add(target)
        return result


class DirectoryImportRowUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    detected_kind: DirectoryImportKind | None = None
    normalized_data: DirectoryImportNormalizedData | None = None
    is_selected: bool | None = None
    proposed_action: DirectoryImportPreviewAction | None = None

    @model_validator(mode="after")
    def block_invalid_selection(self) -> "DirectoryImportRowUpdate":
        if self.is_selected and self.proposed_action == "skip":
            raise ValueError("A skipped row cannot be selected")
        return self


class DirectoryImportMatchUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    proposed_action: DirectoryImportAction
    matched_entry_id: UUID | None = None
    update_fields: list[str] = Field(default_factory=list, max_length=10)
    restore_if_archived: bool = False
    version: int = Field(ge=1)

    @field_validator("update_fields")
    @classmethod
    def validate_update_fields(cls, value: list[str]) -> list[str]:
        if len(value) != len(set(value)) or any(
            item not in DIRECTORY_IMPORT_UPDATE_FIELDS for item in value
        ):
            raise ValueError("Invalid directory import update fields")
        return value

    @model_validator(mode="after")
    def validate_action(self) -> "DirectoryImportMatchUpdate":
        if self.proposed_action == "update":
            if self.matched_entry_id is None:
                raise ValueError("Update requires a matched directory entry")
            if not self.update_fields and not self.restore_if_archived:
                raise ValueError("Update requires at least one selected field")
        elif self.matched_entry_id is not None or self.update_fields or self.restore_if_archived:
            raise ValueError("Only update may use match selection fields")
        return self


class DirectoryImportMatchReasonPublic(BaseModel):
    model_config = ConfigDict(extra="forbid")

    code: str = Field(max_length=64)
    weight: float


class DirectoryImportCandidatePublic(BaseModel):
    model_config = ConfigDict(extra="forbid")

    id: UUID
    display_name: str
    department: str | None = None
    position: str | None = None
    internal_phone: str | None = None
    work_phone: str | None = None
    mobile_phone: str | None = None
    email: EmailStr | None = None
    room: str | None = None
    location: str | None = None
    is_active: bool
    updated_at: datetime
    score: float
    reasons: list[DirectoryImportMatchReasonPublic]


class DirectoryImportValidationPublic(BaseModel):
    create_count: int
    update_count: int
    restore_count: int
    skip_count: int
    blocking_count: int
    stale_count: int
    invalid_count: int
    duplicate_count: int
    can_execute: bool
    blocking_reasons: list[dict[str, Any]]


class DirectoryImportExecutionRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    confirmed: Literal[True]
    version: int = Field(ge=1)


class DirectoryImportExecutionResultPublic(BaseModel):
    batch_id: UUID
    status: Literal["completed", "failed"]
    created: int
    updated: int
    restored: int
    skipped: int
    errors: int
    duration_ms: int
    result_entry_ids: list[UUID]
    error_code: str | None = None


class DirectoryImportRowPublic(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: UUID
    batch_id: UUID
    source_sheet: str | None
    source_row_start: int
    source_row_end: int
    raw_cells: dict[str, Any]
    detected_kind: DirectoryImportKind
    confidence: float | None
    normalized_data: dict[str, Any]
    warnings: list[dict[str, Any]]
    is_selected: bool
    proposed_action: DirectoryImportAction
    match_status: DirectoryImportMatchStatus | None = None
    matched_entry_id: UUID | None = None
    match_score: float | None = None
    match_reasons: list[dict[str, Any]] = Field(default_factory=list)
    match_candidates: list[DirectoryImportCandidatePublic] = Field(default_factory=list)
    update_fields: list[str] = Field(default_factory=list)
    restore_if_archived: bool = False
    expected_entry_updated_at: datetime | None = None
    execution_status: DirectoryImportExecutionStatus = "pending"
    result_entry_id: UUID | None = None
    execution_error: str | None = None
    sort_order: int
    created_at: datetime
    updated_at: datetime


class DirectoryImportBatchPublic(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: UUID
    original_filename: str
    file_type: Literal["xlsx", "csv"]
    file_sha256: str
    available_sheets: list[str]
    selected_sheet: str | None
    parser_mode: DirectoryImportParserMode
    column_mapping: dict[str, str]
    source_columns: list[dict[str, Any]]
    status: DirectoryImportStatus
    total_source_rows: int
    detected_rows: int
    selected_rows: int
    warning_rows: int
    reconciliation_started_at: datetime | None = None
    reconciled_at: datetime | None = None
    execution_started_at: datetime | None = None
    executed_at: datetime | None = None
    execution_summary: dict[str, Any] | None = None
    execution_error: str | None = None
    directory_snapshot_at: datetime | None = None
    version: int = 1
    created_by_user_id: UUID | None
    created_at: datetime
    updated_at: datetime


class DirectoryImportBatchPage(BaseModel):
    items: list[DirectoryImportBatchPublic]
    total: int
    page: int
    limit: int


class DirectoryImportRowPage(BaseModel):
    items: list[DirectoryImportRowPublic]
    total: int
    page: int
    limit: int
