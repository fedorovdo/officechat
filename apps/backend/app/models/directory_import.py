import uuid
from datetime import datetime
from typing import Any

from sqlalchemy import Boolean, CheckConstraint, DateTime, Float, ForeignKey, Index, Integer, String, Text, func
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db.base import Base
from app.models.user import User


class DirectoryImportBatch(Base):
    __tablename__ = "directory_import_batches"
    __table_args__ = (
        CheckConstraint("file_type IN ('xlsx', 'csv')", name="ck_directory_import_batches_file_type"),
        CheckConstraint(
            "parser_mode IN ('auto', 'table', 'legacy_layout')",
            name="ck_directory_import_batches_parser_mode",
        ),
        CheckConstraint(
            "status IN ('draft', 'analyzed', 'reconciled', 'executing', "
            "'completed', 'failed', 'cancelled')",
            name="ck_directory_import_batches_status",
        ),
        Index("ix_directory_import_batches_created_by_user_id", "created_by_user_id"),
        Index("ix_directory_import_batches_status", "status"),
        Index("ix_directory_import_batches_created_at", "created_at"),
    )

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    original_filename: Mapped[str] = mapped_column(String(255), nullable=False)
    file_type: Mapped[str] = mapped_column(String(16), nullable=False)
    file_sha256: Mapped[str] = mapped_column(String(64), nullable=False)
    available_sheets: Mapped[list[str]] = mapped_column(JSONB, nullable=False, default=list)
    selected_sheet: Mapped[str | None] = mapped_column(String(255), nullable=True)
    parser_mode: Mapped[str] = mapped_column(String(32), nullable=False, default="auto")
    column_mapping: Mapped[dict[str, str]] = mapped_column(JSONB, nullable=False, default=dict)
    source_columns: Mapped[list[dict[str, Any]]] = mapped_column(JSONB, nullable=False, default=list)
    status: Mapped[str] = mapped_column(String(16), nullable=False, default="draft")
    total_source_rows: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    detected_rows: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    selected_rows: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    warning_rows: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    reconciliation_started_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    reconciled_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    execution_started_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    executed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    execution_summary: Mapped[dict[str, Any] | None] = mapped_column(JSONB, nullable=True)
    execution_error: Mapped[str | None] = mapped_column(Text, nullable=True)
    directory_snapshot_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    version: Mapped[int] = mapped_column(Integer, nullable=False, default=1, server_default="1")
    created_by_user_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now(), onupdate=func.now()
    )

    created_by: Mapped[User | None] = relationship(foreign_keys=[created_by_user_id])
    rows: Mapped[list["DirectoryImportRow"]] = relationship(
        back_populates="batch", cascade="all, delete-orphan", passive_deletes=True
    )


class DirectoryImportRow(Base):
    __tablename__ = "directory_import_rows"
    __table_args__ = (
        CheckConstraint(
            "detected_kind IN ('person', 'role', 'department_contact', "
            "'organization_metadata', 'unknown')",
            name="ck_directory_import_rows_detected_kind",
        ),
        CheckConstraint(
            "proposed_action IN ('create', 'update', 'skip')",
            name="ck_directory_import_rows_proposed_action",
        ),
        CheckConstraint(
            "match_status IS NULL OR match_status IN ('unmatched', 'exact', 'probable', "
            "'ambiguous', 'batch_duplicate', 'archived_match')",
            name="ck_directory_import_rows_match_status",
        ),
        CheckConstraint(
            "execution_status IN ('pending', 'created', 'updated', 'restored', 'skipped', 'failed')",
            name="ck_directory_import_rows_execution_status",
        ),
        Index("ix_directory_import_rows_batch_id_sort_order", "batch_id", "sort_order"),
        Index("ix_directory_import_rows_batch_id_is_selected", "batch_id", "is_selected"),
        Index("ix_directory_import_rows_matched_entry_id", "matched_entry_id"),
        Index("ix_directory_import_rows_execution_status", "execution_status"),
        Index("ix_directory_import_rows_proposed_action", "proposed_action"),
    )

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    batch_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("directory_import_batches.id", ondelete="CASCADE"),
        nullable=False,
    )
    source_sheet: Mapped[str | None] = mapped_column(String(255), nullable=True)
    source_row_start: Mapped[int] = mapped_column(Integer, nullable=False)
    source_row_end: Mapped[int] = mapped_column(Integer, nullable=False)
    raw_cells: Mapped[dict[str, Any]] = mapped_column(JSONB, nullable=False, default=dict)
    detected_kind: Mapped[str] = mapped_column(String(32), nullable=False, default="unknown")
    confidence: Mapped[float | None] = mapped_column(Float, nullable=True)
    normalized_data: Mapped[dict[str, Any]] = mapped_column(JSONB, nullable=False, default=dict)
    warnings: Mapped[list[dict[str, Any]]] = mapped_column(JSONB, nullable=False, default=list)
    is_selected: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    proposed_action: Mapped[str] = mapped_column(String(16), nullable=False, default="skip")
    match_status: Mapped[str | None] = mapped_column(String(32), nullable=True)
    matched_entry_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("directory_entries.id", ondelete="SET NULL"),
        nullable=True,
    )
    match_score: Mapped[float | None] = mapped_column(Float, nullable=True)
    match_reasons: Mapped[list[dict[str, Any]]] = mapped_column(
        JSONB, nullable=False, default=list
    )
    match_candidates: Mapped[list[dict[str, Any]]] = mapped_column(
        JSONB, nullable=False, default=list
    )
    update_fields: Mapped[list[str]] = mapped_column(JSONB, nullable=False, default=list)
    restore_if_archived: Mapped[bool] = mapped_column(
        Boolean, nullable=False, default=False, server_default="false"
    )
    expected_entry_updated_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    execution_status: Mapped[str] = mapped_column(
        String(16), nullable=False, default="pending", server_default="pending"
    )
    result_entry_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("directory_entries.id", ondelete="SET NULL"),
        nullable=True,
    )
    execution_error: Mapped[str | None] = mapped_column(Text, nullable=True)
    sort_order: Mapped[int] = mapped_column(Integer, nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now(), onupdate=func.now()
    )

    batch: Mapped[DirectoryImportBatch] = relationship(back_populates="rows")
