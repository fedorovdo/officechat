"""add retention and storage management metadata

Revision ID: 20260703_0014
Revises: 20260703_0013
Create Date: 2026-07-03
"""

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

revision = "20260703_0014"
down_revision = "20260703_0013"
branch_labels = None
depends_on = None

MESSAGE_TABLES = ("messages", "direct_messages", "discussion_messages")
ATTACHMENT_TABLES = (
    "message_attachments",
    "direct_message_attachments",
    "discussion_message_attachments",
)


def upgrade() -> None:
    for table_name in MESSAGE_TABLES:
        op.add_column(
            table_name,
            sa.Column("is_archived", sa.Boolean(), server_default=sa.false(), nullable=False),
        )
        op.add_column(table_name, sa.Column("archived_at", sa.DateTime(timezone=True), nullable=True))
        op.create_index(f"ix_{table_name}_is_archived", table_name, ["is_archived"], unique=False)

    for table_name in ATTACHMENT_TABLES:
        op.add_column(
            table_name,
            sa.Column("file_available", sa.Boolean(), server_default=sa.true(), nullable=False),
        )
        op.add_column(table_name, sa.Column("file_deleted_at", sa.DateTime(timezone=True), nullable=True))

    op.create_table(
        "retention_settings",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("retention_enabled", sa.Boolean(), server_default=sa.false(), nullable=False),
        sa.Column("active_history_days", sa.Integer(), server_default="0", nullable=False),
        sa.Column("archive_enabled", sa.Boolean(), server_default=sa.true(), nullable=False),
        sa.Column("attachment_retention_days", sa.Integer(), nullable=True),
        sa.Column("delete_archived_after_days", sa.Integer(), nullable=True),
        sa.Column("cleanup_batch_size", sa.Integer(), server_default="500", nullable=False),
        sa.Column("cleanup_interval_hours", sa.Integer(), server_default="24", nullable=False),
        sa.Column("last_cleanup_started_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("last_cleanup_finished_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("last_cleanup_status", sa.String(length=32), nullable=True),
        sa.Column("last_cleanup_summary", sa.JSON(), nullable=True),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.Column("updated_by_user_id", postgresql.UUID(as_uuid=True), nullable=True),
        sa.ForeignKeyConstraint(["updated_by_user_id"], ["users.id"], ondelete="SET NULL"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.execute(
        "INSERT INTO retention_settings "
        "(id, retention_enabled, active_history_days, archive_enabled, cleanup_batch_size, cleanup_interval_hours) "
        "VALUES (1, false, 0, true, 500, 24)"
    )

    op.create_table(
        "retention_audit",
        sa.Column("id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("action", sa.String(length=64), nullable=False),
        sa.Column("actor_user_id", postgresql.UUID(as_uuid=True), nullable=True),
        sa.Column("details", sa.JSON(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.ForeignKeyConstraint(["actor_user_id"], ["users.id"], ondelete="SET NULL"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_retention_audit_action", "retention_audit", ["action"], unique=False)
    op.create_index("ix_retention_audit_actor_user_id", "retention_audit", ["actor_user_id"], unique=False)


def downgrade() -> None:
    op.drop_index("ix_retention_audit_actor_user_id", table_name="retention_audit")
    op.drop_index("ix_retention_audit_action", table_name="retention_audit")
    op.drop_table("retention_audit")
    op.drop_table("retention_settings")

    for table_name in reversed(ATTACHMENT_TABLES):
        op.drop_column(table_name, "file_deleted_at")
        op.drop_column(table_name, "file_available")

    for table_name in reversed(MESSAGE_TABLES):
        op.drop_index(f"ix_{table_name}_is_archived", table_name=table_name)
        op.drop_column(table_name, "archived_at")
        op.drop_column(table_name, "is_archived")
