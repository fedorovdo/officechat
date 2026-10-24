"""Add structured announcement formatting and author-owned reusable templates."""
from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "20261014_0027"
down_revision: str | None = "20260728_0026"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column("broadcast_announcements", sa.Column("body_doc", postgresql.JSONB(), nullable=True))
    op.create_table(
        "broadcast_templates",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column("created_by_user_id", postgresql.UUID(as_uuid=True),
                  sa.ForeignKey("users.id", ondelete="SET NULL"), nullable=True),
        sa.Column("created_by_display_name", sa.String(160), nullable=False),
        sa.Column("name", sa.String(100), nullable=False),
        sa.Column("title", sa.String(160), nullable=False),
        sa.Column("body", sa.Text(), nullable=False),
        sa.Column("body_doc", postgresql.JSONB(), nullable=True),
        sa.Column("priority", sa.String(32), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.CheckConstraint("priority IN ('normal', 'important', 'urgent')", name="ck_broadcast_templates_priority"),
    )
    op.create_index("ix_broadcast_templates_created_by_user_id", "broadcast_templates", ["created_by_user_id"])


def downgrade() -> None:
    op.drop_table("broadcast_templates")
    op.drop_column("broadcast_announcements", "body_doc")
