"""add directory import reconciliation and execution

Revision ID: 20260728_0026
Revises: 20260727_0025
Create Date: 2026-07-28 12:00:00
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "20260728_0026"
down_revision: str | None = "20260727_0025"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.drop_constraint(
        "ck_directory_import_batches_status",
        "directory_import_batches",
        type_="check",
    )
    op.create_check_constraint(
        "ck_directory_import_batches_status",
        "directory_import_batches",
        "status IN ('draft', 'analyzed', 'reconciled', 'executing', "
        "'completed', 'failed', 'cancelled')",
    )
    op.add_column(
        "directory_import_batches",
        sa.Column("reconciliation_started_at", sa.DateTime(timezone=True), nullable=True),
    )
    op.add_column(
        "directory_import_batches",
        sa.Column("reconciled_at", sa.DateTime(timezone=True), nullable=True),
    )
    op.add_column(
        "directory_import_batches",
        sa.Column("execution_started_at", sa.DateTime(timezone=True), nullable=True),
    )
    op.add_column(
        "directory_import_batches",
        sa.Column("executed_at", sa.DateTime(timezone=True), nullable=True),
    )
    op.add_column(
        "directory_import_batches",
        sa.Column(
            "execution_summary",
            postgresql.JSONB(astext_type=sa.Text()),
            nullable=True,
        ),
    )
    op.add_column(
        "directory_import_batches",
        sa.Column("execution_error", sa.Text(), nullable=True),
    )
    op.add_column(
        "directory_import_batches",
        sa.Column("directory_snapshot_at", sa.DateTime(timezone=True), nullable=True),
    )
    op.add_column(
        "directory_import_batches",
        sa.Column("version", sa.Integer(), server_default="1", nullable=False),
    )

    op.drop_constraint(
        "ck_directory_import_rows_proposed_action",
        "directory_import_rows",
        type_="check",
    )
    op.create_check_constraint(
        "ck_directory_import_rows_proposed_action",
        "directory_import_rows",
        "proposed_action IN ('create', 'update', 'skip')",
    )
    op.add_column(
        "directory_import_rows",
        sa.Column("match_status", sa.String(length=32), nullable=True),
    )
    op.add_column(
        "directory_import_rows",
        sa.Column("matched_entry_id", postgresql.UUID(as_uuid=True), nullable=True),
    )
    op.add_column(
        "directory_import_rows",
        sa.Column("match_score", sa.Float(), nullable=True),
    )
    op.add_column(
        "directory_import_rows",
        sa.Column(
            "match_reasons",
            postgresql.JSONB(astext_type=sa.Text()),
            server_default=sa.text("'[]'::jsonb"),
            nullable=False,
        ),
    )
    op.add_column(
        "directory_import_rows",
        sa.Column(
            "match_candidates",
            postgresql.JSONB(astext_type=sa.Text()),
            server_default=sa.text("'[]'::jsonb"),
            nullable=False,
        ),
    )
    op.add_column(
        "directory_import_rows",
        sa.Column(
            "update_fields",
            postgresql.JSONB(astext_type=sa.Text()),
            server_default=sa.text("'[]'::jsonb"),
            nullable=False,
        ),
    )
    op.add_column(
        "directory_import_rows",
        sa.Column(
            "restore_if_archived",
            sa.Boolean(),
            server_default=sa.text("false"),
            nullable=False,
        ),
    )
    op.add_column(
        "directory_import_rows",
        sa.Column("expected_entry_updated_at", sa.DateTime(timezone=True), nullable=True),
    )
    op.add_column(
        "directory_import_rows",
        sa.Column(
            "execution_status",
            sa.String(length=16),
            server_default="pending",
            nullable=False,
        ),
    )
    op.add_column(
        "directory_import_rows",
        sa.Column("result_entry_id", postgresql.UUID(as_uuid=True), nullable=True),
    )
    op.add_column(
        "directory_import_rows",
        sa.Column("execution_error", sa.Text(), nullable=True),
    )
    op.create_check_constraint(
        "ck_directory_import_rows_match_status",
        "directory_import_rows",
        "match_status IS NULL OR match_status IN ('unmatched', 'exact', 'probable', "
        "'ambiguous', 'batch_duplicate', 'archived_match')",
    )
    op.create_check_constraint(
        "ck_directory_import_rows_execution_status",
        "directory_import_rows",
        "execution_status IN ('pending', 'created', 'updated', 'restored', 'skipped', 'failed')",
    )
    op.create_foreign_key(
        "fk_directory_import_rows_matched_entry_id",
        "directory_import_rows",
        "directory_entries",
        ["matched_entry_id"],
        ["id"],
        ondelete="SET NULL",
    )
    op.create_foreign_key(
        "fk_directory_import_rows_result_entry_id",
        "directory_import_rows",
        "directory_entries",
        ["result_entry_id"],
        ["id"],
        ondelete="SET NULL",
    )
    op.create_index(
        "ix_directory_import_rows_matched_entry_id",
        "directory_import_rows",
        ["matched_entry_id"],
    )
    op.create_index(
        "ix_directory_import_rows_execution_status",
        "directory_import_rows",
        ["execution_status"],
    )
    op.create_index(
        "ix_directory_import_rows_proposed_action",
        "directory_import_rows",
        ["proposed_action"],
    )


def downgrade() -> None:
    op.execute(
        "UPDATE directory_import_rows "
        "SET proposed_action = 'skip', is_selected = false "
        "WHERE proposed_action = 'update'"
    )
    op.execute(
        "UPDATE directory_import_batches SET status = 'analyzed' "
        "WHERE status NOT IN ('draft', 'analyzed', 'cancelled')"
    )
    # Keep downgrade usable for local databases that briefly ran an earlier
    # uncommitted form of this revision without the two Stage 2 indexes.
    op.execute("DROP INDEX IF EXISTS ix_directory_import_rows_proposed_action")
    op.execute("DROP INDEX IF EXISTS ix_directory_import_rows_execution_status")
    op.drop_index(
        "ix_directory_import_rows_matched_entry_id",
        table_name="directory_import_rows",
    )
    op.drop_constraint(
        "fk_directory_import_rows_result_entry_id",
        "directory_import_rows",
        type_="foreignkey",
    )
    op.drop_constraint(
        "fk_directory_import_rows_matched_entry_id",
        "directory_import_rows",
        type_="foreignkey",
    )
    op.drop_constraint(
        "ck_directory_import_rows_execution_status",
        "directory_import_rows",
        type_="check",
    )
    op.drop_constraint(
        "ck_directory_import_rows_match_status",
        "directory_import_rows",
        type_="check",
    )
    for column in (
        "execution_error",
        "result_entry_id",
        "execution_status",
        "expected_entry_updated_at",
        "restore_if_archived",
        "update_fields",
        "match_candidates",
        "match_reasons",
        "match_score",
        "matched_entry_id",
        "match_status",
    ):
        op.drop_column("directory_import_rows", column)
    op.drop_constraint(
        "ck_directory_import_rows_proposed_action",
        "directory_import_rows",
        type_="check",
    )
    op.create_check_constraint(
        "ck_directory_import_rows_proposed_action",
        "directory_import_rows",
        "proposed_action IN ('create', 'skip')",
    )

    for column in (
        "version",
        "directory_snapshot_at",
        "execution_error",
        "execution_summary",
        "executed_at",
        "execution_started_at",
        "reconciled_at",
        "reconciliation_started_at",
    ):
        op.drop_column("directory_import_batches", column)
    op.drop_constraint(
        "ck_directory_import_batches_status",
        "directory_import_batches",
        type_="check",
    )
    op.create_check_constraint(
        "ck_directory_import_batches_status",
        "directory_import_batches",
        "status IN ('draft', 'analyzed', 'cancelled')",
    )
