"""create directory import preview tables

Revision ID: 20260727_0025
Revises: 20260725_0024
Create Date: 2026-07-27 12:00:00
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "20260727_0025"
down_revision: str | None = "20260725_0024"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "directory_import_batches",
        sa.Column("id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("original_filename", sa.String(length=255), nullable=False),
        sa.Column("file_type", sa.String(length=16), nullable=False),
        sa.Column("file_sha256", sa.String(length=64), nullable=False),
        sa.Column("available_sheets", postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.Column("selected_sheet", sa.String(length=255), nullable=True),
        sa.Column("parser_mode", sa.String(length=32), nullable=False),
        sa.Column("column_mapping", postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.Column("source_columns", postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.Column("status", sa.String(length=16), nullable=False),
        sa.Column("total_source_rows", sa.Integer(), nullable=False),
        sa.Column("detected_rows", sa.Integer(), nullable=False),
        sa.Column("selected_rows", sa.Integer(), nullable=False),
        sa.Column("warning_rows", sa.Integer(), nullable=False),
        sa.Column("created_by_user_id", postgresql.UUID(as_uuid=True), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.CheckConstraint("file_type IN ('xlsx', 'csv')", name="ck_directory_import_batches_file_type"),
        sa.CheckConstraint(
            "parser_mode IN ('auto', 'table', 'legacy_layout')",
            name="ck_directory_import_batches_parser_mode",
        ),
        sa.CheckConstraint(
            "status IN ('draft', 'analyzed', 'cancelled')",
            name="ck_directory_import_batches_status",
        ),
        sa.ForeignKeyConstraint(["created_by_user_id"], ["users.id"], ondelete="SET NULL"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(
        "ix_directory_import_batches_created_by_user_id",
        "directory_import_batches",
        ["created_by_user_id"],
    )
    op.create_index(
        "ix_directory_import_batches_status", "directory_import_batches", ["status"]
    )
    op.create_index(
        "ix_directory_import_batches_created_at", "directory_import_batches", ["created_at"]
    )

    op.create_table(
        "directory_import_rows",
        sa.Column("id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("batch_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("source_sheet", sa.String(length=255), nullable=True),
        sa.Column("source_row_start", sa.Integer(), nullable=False),
        sa.Column("source_row_end", sa.Integer(), nullable=False),
        sa.Column("raw_cells", postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.Column("detected_kind", sa.String(length=32), nullable=False),
        sa.Column("confidence", sa.Float(), nullable=True),
        sa.Column("normalized_data", postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.Column("warnings", postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.Column("is_selected", sa.Boolean(), nullable=False),
        sa.Column("proposed_action", sa.String(length=16), nullable=False),
        sa.Column("sort_order", sa.Integer(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.CheckConstraint(
            "detected_kind IN ('person', 'role', 'department_contact', "
            "'organization_metadata', 'unknown')",
            name="ck_directory_import_rows_detected_kind",
        ),
        sa.CheckConstraint(
            "proposed_action IN ('create', 'skip')",
            name="ck_directory_import_rows_proposed_action",
        ),
        sa.ForeignKeyConstraint(
            ["batch_id"], ["directory_import_batches.id"], ondelete="CASCADE"
        ),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(
        "ix_directory_import_rows_batch_id_sort_order",
        "directory_import_rows",
        ["batch_id", "sort_order"],
    )
    op.create_index(
        "ix_directory_import_rows_batch_id_is_selected",
        "directory_import_rows",
        ["batch_id", "is_selected"],
    )


def downgrade() -> None:
    op.drop_index("ix_directory_import_rows_batch_id_is_selected", table_name="directory_import_rows")
    op.drop_index("ix_directory_import_rows_batch_id_sort_order", table_name="directory_import_rows")
    op.drop_table("directory_import_rows")
    op.drop_index("ix_directory_import_batches_created_at", table_name="directory_import_batches")
    op.drop_index("ix_directory_import_batches_status", table_name="directory_import_batches")
    op.drop_index(
        "ix_directory_import_batches_created_by_user_id", table_name="directory_import_batches"
    )
    op.drop_table("directory_import_batches")
