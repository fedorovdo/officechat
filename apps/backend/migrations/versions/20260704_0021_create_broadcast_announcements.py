"""create broadcast announcements

Revision ID: 20260704_0021
Revises: 20260704_0020
Create Date: 2026-07-11 06:30:00.000000
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "20260704_0021"
down_revision: str | None = "20260704_0020"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "broadcast_announcements",
        sa.Column("id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("created_by_user_id", postgresql.UUID(as_uuid=True), nullable=True),
        sa.Column("created_by_username", sa.String(length=64), nullable=False),
        sa.Column("created_by_display_name", sa.String(length=160), nullable=False),
        sa.Column("title", sa.String(length=160), nullable=False),
        sa.Column("body", sa.Text(), nullable=False),
        sa.Column("priority", sa.String(length=32), nullable=False),
        sa.Column("status", sa.String(length=32), nullable=False),
        sa.Column("audience_type", sa.String(length=32), nullable=False),
        sa.Column("audience_definition", postgresql.JSONB(astext_type=sa.Text()), nullable=True),
        sa.Column("recipient_count", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("notified_count", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("read_count", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("failed_count", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("idempotency_key", sa.String(length=128), nullable=True),
        sa.Column("sent_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("retracted_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.CheckConstraint("priority IN ('normal', 'important', 'urgent')", name="ck_broadcast_announcements_priority"),
        sa.CheckConstraint(
            "status IN ('draft', 'sending', 'sent', 'failed', 'partially_failed', 'retracted')",
            name="ck_broadcast_announcements_status",
        ),
        sa.CheckConstraint(
            "audience_type IN ('all_active_users', 'selected_groups', 'selected_users')",
            name="ck_broadcast_announcements_audience_type",
        ),
        sa.ForeignKeyConstraint(["created_by_user_id"], ["users.id"], ondelete="SET NULL"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("idempotency_key", name="uq_broadcast_announcements_idempotency_key"),
    )
    op.create_index("ix_broadcast_announcements_created_by_user_id", "broadcast_announcements", ["created_by_user_id"])
    op.create_index("ix_broadcast_announcements_sent_at", "broadcast_announcements", ["sent_at"])
    op.create_index("ix_broadcast_announcements_status", "broadcast_announcements", ["status"])

    op.create_table(
        "broadcast_recipients",
        sa.Column("id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("broadcast_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("user_id", postgresql.UUID(as_uuid=True), nullable=True),
        sa.Column("username_snapshot", sa.String(length=64), nullable=False),
        sa.Column("display_name_snapshot", sa.String(length=160), nullable=False),
        sa.Column("notification_status", sa.String(length=32), nullable=False),
        sa.Column("notified_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("read_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("dismissed_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("error_code", sa.String(length=64), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.CheckConstraint(
            "notification_status IN ('pending', 'notified', 'offline', 'failed')",
            name="ck_broadcast_recipients_notification_status",
        ),
        sa.ForeignKeyConstraint(["broadcast_id"], ["broadcast_announcements.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="SET NULL"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("broadcast_id", "user_id", name="uq_broadcast_recipients_broadcast_user"),
    )
    op.create_index("ix_broadcast_recipients_broadcast_id", "broadcast_recipients", ["broadcast_id"])
    op.create_index("ix_broadcast_recipients_user_read", "broadcast_recipients", ["user_id", "read_at"])


def downgrade() -> None:
    op.drop_index("ix_broadcast_recipients_user_read", table_name="broadcast_recipients")
    op.drop_index("ix_broadcast_recipients_broadcast_id", table_name="broadcast_recipients")
    op.drop_table("broadcast_recipients")
    op.drop_index("ix_broadcast_announcements_status", table_name="broadcast_announcements")
    op.drop_index("ix_broadcast_announcements_sent_at", table_name="broadcast_announcements")
    op.drop_index("ix_broadcast_announcements_created_by_user_id", table_name="broadcast_announcements")
    op.drop_table("broadcast_announcements")
