"""create centralized audit events

Revision ID: 20260704_0015
Revises: 20260703_0014
Create Date: 2026-07-04
"""

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

revision = "20260704_0015"
down_revision = "20260703_0014"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "audit_events",
        sa.Column("id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("actor_user_id", postgresql.UUID(as_uuid=True), nullable=True),
        sa.Column("actor_username", sa.String(length=64), nullable=True),
        sa.Column("actor_display_name", sa.String(length=160), nullable=True),
        sa.Column("actor_role", sa.String(length=32), nullable=True),
        sa.Column("event_type", sa.String(length=128), nullable=False),
        sa.Column("category", sa.String(length=64), nullable=False),
        sa.Column("action", sa.String(length=64), nullable=False),
        sa.Column("status", sa.String(length=32), nullable=False),
        sa.Column("target_type", sa.String(length=64), nullable=True),
        sa.Column("target_id", sa.String(length=255), nullable=True),
        sa.Column("target_label", sa.String(length=500), nullable=True),
        sa.Column("source_ip", sa.String(length=64), nullable=True),
        sa.Column("user_agent", sa.String(length=500), nullable=True),
        sa.Column("request_id", sa.String(length=64), nullable=True),
        sa.Column("details", sa.JSON(), nullable=True),
        sa.Column("error_code", sa.String(length=128), nullable=True),
        sa.Column("error_message", sa.Text(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.ForeignKeyConstraint(["actor_user_id"], ["users.id"], ondelete="SET NULL"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_audit_events_created_at", "audit_events", ["created_at"])
    op.create_index("ix_audit_events_actor_user_id", "audit_events", ["actor_user_id"])
    op.create_index("ix_audit_events_event_type", "audit_events", ["event_type"])
    op.create_index("ix_audit_events_category", "audit_events", ["category"])
    op.create_index("ix_audit_events_status", "audit_events", ["status"])
    op.create_index("ix_audit_events_target", "audit_events", ["target_type", "target_id"])


def downgrade() -> None:
    op.drop_index("ix_audit_events_target", table_name="audit_events")
    op.drop_index("ix_audit_events_status", table_name="audit_events")
    op.drop_index("ix_audit_events_category", table_name="audit_events")
    op.drop_index("ix_audit_events_event_type", table_name="audit_events")
    op.drop_index("ix_audit_events_actor_user_id", table_name="audit_events")
    op.drop_index("ix_audit_events_created_at", table_name="audit_events")
    op.drop_table("audit_events")
