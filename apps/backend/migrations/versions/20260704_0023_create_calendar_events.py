"""create calendar events

Revision ID: 20260704_0023
Revises: 20260704_0022
Create Date: 2026-07-12 11:00:00.000000
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "20260704_0023"
down_revision: str | None = "20260704_0022"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "calendar_events",
        sa.Column("id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("title", sa.String(length=200), nullable=False),
        sa.Column("description", sa.Text(), nullable=True),
        sa.Column("event_type", sa.String(length=32), nullable=False),
        sa.Column("status", sa.String(length=32), nullable=False, server_default="scheduled"),
        sa.Column("starts_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("ends_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("is_all_day", sa.Boolean(), nullable=False, server_default=sa.false()),
        sa.Column("all_day_start_date", sa.Date(), nullable=True),
        sa.Column("all_day_end_date", sa.Date(), nullable=True),
        sa.Column("timezone", sa.String(length=64), nullable=False),
        sa.Column("location", sa.String(length=500), nullable=True),
        sa.Column("conference_url", sa.String(length=1000), nullable=True),
        sa.Column("audience_type", sa.String(length=32), nullable=False),
        sa.Column("audience_definition", postgresql.JSONB(astext_type=sa.Text()), nullable=True),
        sa.Column("created_by_user_id", postgresql.UUID(as_uuid=True), nullable=True),
        sa.Column("created_by_username", sa.String(length=64), nullable=True),
        sa.Column("created_by_display_name", sa.String(length=160), nullable=True),
        sa.Column("cancelled_by_user_id", postgresql.UUID(as_uuid=True), nullable=True),
        sa.Column("cancelled_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("cancellation_reason", sa.String(length=1000), nullable=True),
        sa.Column("reminder_minutes", postgresql.JSONB(astext_type=sa.Text()), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.CheckConstraint(
            "event_type IN ('meeting', 'video_conference', 'office_event', 'training', 'maintenance', 'other')",
            name="ck_calendar_events_event_type",
        ),
        sa.CheckConstraint(
            "status IN ('scheduled', 'rescheduled', 'cancelled', 'completed')",
            name="ck_calendar_events_status",
        ),
        sa.CheckConstraint(
            "audience_type IN ('all_active_users', 'selected_groups', 'selected_users')",
            name="ck_calendar_events_audience_type",
        ),
        sa.CheckConstraint(
            "(is_all_day = true AND all_day_start_date IS NOT NULL AND all_day_end_date IS NOT NULL "
            "AND starts_at IS NULL AND ends_at IS NULL AND all_day_end_date >= all_day_start_date) "
            "OR (is_all_day = false AND starts_at IS NOT NULL AND ends_at IS NOT NULL AND ends_at > starts_at "
            "AND all_day_start_date IS NULL AND all_day_end_date IS NULL)",
            name="ck_calendar_events_time_shape",
        ),
        sa.ForeignKeyConstraint(["cancelled_by_user_id"], ["users.id"], ondelete="SET NULL"),
        sa.ForeignKeyConstraint(["created_by_user_id"], ["users.id"], ondelete="SET NULL"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_calendar_events_all_day_end_date", "calendar_events", ["all_day_end_date"])
    op.create_index("ix_calendar_events_all_day_start_date", "calendar_events", ["all_day_start_date"])
    op.create_index("ix_calendar_events_created_by_user_id", "calendar_events", ["created_by_user_id"])
    op.create_index("ix_calendar_events_ends_at", "calendar_events", ["ends_at"])
    op.create_index("ix_calendar_events_event_type", "calendar_events", ["event_type"])
    op.create_index("ix_calendar_events_starts_at", "calendar_events", ["starts_at"])
    op.create_index("ix_calendar_events_status", "calendar_events", ["status"])

    op.create_table(
        "calendar_event_recipients",
        sa.Column("id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("event_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("user_id", postgresql.UUID(as_uuid=True), nullable=True),
        sa.Column("username_snapshot", sa.String(length=64), nullable=True),
        sa.Column("display_name_snapshot", sa.String(length=160), nullable=True),
        sa.Column("source_type", sa.String(length=32), nullable=False),
        sa.Column("source_id", postgresql.UUID(as_uuid=True), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.CheckConstraint("source_type IN ('all_users', 'group', 'individual')", name="ck_calendar_event_recipients_source_type"),
        sa.ForeignKeyConstraint(["event_id"], ["calendar_events.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="SET NULL"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("event_id", "user_id", name="uq_calendar_event_recipients_event_user"),
    )
    op.create_index("ix_calendar_event_recipients_event_id", "calendar_event_recipients", ["event_id"])
    op.create_index("ix_calendar_event_recipients_user_event", "calendar_event_recipients", ["user_id", "event_id"])
    op.create_index("ix_calendar_event_recipients_user_id", "calendar_event_recipients", ["user_id"])

    op.create_table(
        "calendar_reminder_deliveries",
        sa.Column("id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("event_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("user_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("reminder_minutes", sa.Integer(), nullable=False),
        sa.Column("scheduled_for", sa.DateTime(timezone=True), nullable=False),
        sa.Column("delivered_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("status", sa.String(length=32), nullable=False, server_default="pending"),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.CheckConstraint("status IN ('pending', 'delivered', 'skipped', 'failed')", name="ck_calendar_reminder_deliveries_status"),
        sa.ForeignKeyConstraint(["event_id"], ["calendar_events.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint(
            "event_id",
            "user_id",
            "reminder_minutes",
            "scheduled_for",
            name="uq_calendar_reminder_deliveries_event_user_minute_time",
        ),
    )
    op.create_index("ix_calendar_reminder_deliveries_due", "calendar_reminder_deliveries", ["status", "scheduled_for"])
    op.create_index("ix_calendar_reminder_deliveries_event_id", "calendar_reminder_deliveries", ["event_id"])
    op.create_index("ix_calendar_reminder_deliveries_user_id", "calendar_reminder_deliveries", ["user_id"])

    op.add_column("notification_preferences", sa.Column("calendar_events_enabled", sa.Boolean(), nullable=False, server_default=sa.true()))
    op.add_column("notification_preferences", sa.Column("calendar_reminders_enabled", sa.Boolean(), nullable=False, server_default=sa.true()))
    op.add_column("notification_preferences", sa.Column("calendar_changes_enabled", sa.Boolean(), nullable=False, server_default=sa.true()))


def downgrade() -> None:
    op.drop_column("notification_preferences", "calendar_changes_enabled")
    op.drop_column("notification_preferences", "calendar_reminders_enabled")
    op.drop_column("notification_preferences", "calendar_events_enabled")
    op.drop_index("ix_calendar_reminder_deliveries_user_id", table_name="calendar_reminder_deliveries")
    op.drop_index("ix_calendar_reminder_deliveries_event_id", table_name="calendar_reminder_deliveries")
    op.drop_index("ix_calendar_reminder_deliveries_due", table_name="calendar_reminder_deliveries")
    op.drop_table("calendar_reminder_deliveries")
    op.drop_index("ix_calendar_event_recipients_user_id", table_name="calendar_event_recipients")
    op.drop_index("ix_calendar_event_recipients_user_event", table_name="calendar_event_recipients")
    op.drop_index("ix_calendar_event_recipients_event_id", table_name="calendar_event_recipients")
    op.drop_table("calendar_event_recipients")
    op.drop_index("ix_calendar_events_status", table_name="calendar_events")
    op.drop_index("ix_calendar_events_starts_at", table_name="calendar_events")
    op.drop_index("ix_calendar_events_event_type", table_name="calendar_events")
    op.drop_index("ix_calendar_events_ends_at", table_name="calendar_events")
    op.drop_index("ix_calendar_events_created_by_user_id", table_name="calendar_events")
    op.drop_index("ix_calendar_events_all_day_start_date", table_name="calendar_events")
    op.drop_index("ix_calendar_events_all_day_end_date", table_name="calendar_events")
    op.drop_table("calendar_events")
