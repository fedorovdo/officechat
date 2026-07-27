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
DirectoryImportStatus = Literal["draft", "analyzed", "cancelled"]
DirectoryImportKind = Literal[
    "person", "role", "department_contact", "organization_metadata", "unknown"
]
DirectoryImportAction = Literal["create", "skip"]
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
    proposed_action: DirectoryImportAction | None = None

    @model_validator(mode="after")
    def block_invalid_selection(self) -> "DirectoryImportRowUpdate":
        if self.is_selected and self.proposed_action == "skip":
            raise ValueError("A skipped row cannot be selected")
        return self


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
