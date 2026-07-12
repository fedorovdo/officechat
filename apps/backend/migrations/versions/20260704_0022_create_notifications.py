"""create notifications

Revision ID: 20260704_0022
Revises: 20260704_0021
Create Date: 2026-07-12 10:00:00.000000
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "20260704_0022"
down_revision: str | None = "20260704_0021"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "notifications",
        sa.Column("id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("user_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("type", sa.String(length=64), nullable=False),
        sa.Column("category", sa.String(length=64), nullable=False),
        sa.Column("source_type", sa.String(length=64), nullable=True),
        sa.Column("source_id", sa.String(length=128), nullable=True),
        sa.Column("chat_type", sa.String(length=32), nullable=True),
        sa.Column("chat_id", postgresql.UUID(as_uuid=True), nullable=True),
        sa.Column("message_id", postgresql.UUID(as_uuid=True), nullable=True),
        sa.Column("actor_user_id", postgresql.UUID(as_uuid=True), nullable=True),
        sa.Column("actor_username", sa.String(length=64), nullable=True),
        sa.Column("actor_display_name", sa.String(length=160), nullable=True),
        sa.Column("title_key", sa.String(length=128), nullable=False),
        sa.Column("body_preview", sa.String(length=240), nullable=True),
        sa.Column("metadata", postgresql.JSONB(astext_type=sa.Text()), nullable=True),
        sa.Column("dedupe_key", sa.String(length=512), nullable=False),
        sa.Column("is_read", sa.Boolean(), nullable=False, server_default=sa.false()),
        sa.Column("read_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("is_dismissed", sa.Boolean(), nullable=False, server_default=sa.false()),
        sa.Column("dismissed_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.ForeignKeyConstraint(["actor_user_id"], ["users.id"], ondelete="SET NULL"),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("dedupe_key", name="uq_notifications_dedupe_key"),
    )
    op.create_index("ix_notifications_category", "notifications", ["category"])
    op.create_index("ix_notifications_chat", "notifications", ["chat_type", "chat_id"])
    op.create_index("ix_notifications_message_id", "notifications", ["message_id"])
    op.create_index("ix_notifications_source", "notifications", ["source_type", "source_id"])
    op.create_index("ix_notifications_user_created", "notifications", ["user_id", "created_at"])
    op.create_index("ix_notifications_user_read", "notifications", ["user_id", "is_read"])

    op.create_table(
        "notification_preferences",
        sa.Column("id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("user_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("mentions_enabled", sa.Boolean(), nullable=False, server_default=sa.true()),
        sa.Column("replies_enabled", sa.Boolean(), nullable=False, server_default=sa.true()),
        sa.Column("reactions_enabled", sa.Boolean(), nullable=False, server_default=sa.true()),
        sa.Column("direct_messages_enabled", sa.Boolean(), nullable=False, server_default=sa.true()),
        sa.Column("group_messages_enabled", sa.Boolean(), nullable=False, server_default=sa.false()),
        sa.Column("discussion_messages_enabled", sa.Boolean(), nullable=False, server_default=sa.true()),
        sa.Column("announcements_enabled", sa.Boolean(), nullable=False, server_default=sa.true()),
        sa.Column("pins_enabled", sa.Boolean(), nullable=False, server_default=sa.false()),
        sa.Column("system_enabled", sa.Boolean(), nullable=False, server_default=sa.true()),
        sa.Column("desktop_notifications_enabled", sa.Boolean(), nullable=False, server_default=sa.false()),
        sa.Column("sound_enabled", sa.Boolean(), nullable=False, server_default=sa.false()),
        sa.Column("quiet_hours_enabled", sa.Boolean(), nullable=False, server_default=sa.false()),
        sa.Column("quiet_hours_start", sa.String(length=5), nullable=True),
        sa.Column("quiet_hours_end", sa.String(length=5), nullable=True),
        sa.Column("timezone", sa.String(length=64), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("user_id"),
    )
    op.create_index("ix_notification_preferences_user_id", "notification_preferences", ["user_id"])


def downgrade() -> None:
    op.drop_index("ix_notification_preferences_user_id", table_name="notification_preferences")
    op.drop_table("notification_preferences")
    op.drop_index("ix_notifications_user_read", table_name="notifications")
    op.drop_index("ix_notifications_user_created", table_name="notifications")
    op.drop_index("ix_notifications_source", table_name="notifications")
    op.drop_index("ix_notifications_message_id", table_name="notifications")
    op.drop_index("ix_notifications_chat", table_name="notifications")
    op.drop_index("ix_notifications_category", table_name="notifications")
    op.drop_table("notifications")
