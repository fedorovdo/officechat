"""create message mentions table

Revision ID: 20260602_0008
Revises: 20260525_0007
Create Date: 2026-06-02
"""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

revision = "20260602_0008"
down_revision = "20260525_0007"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "message_mentions",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True, nullable=False),
        sa.Column("message_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("group_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("mentioned_user_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.ForeignKeyConstraint(["message_id"], ["messages.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["group_id"], ["groups.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["mentioned_user_id"], ["users.id"], ondelete="CASCADE"),
        sa.UniqueConstraint("message_id", "mentioned_user_id", name="uq_message_mentions_message_user"),
    )
    op.create_index("ix_message_mentions_message_id", "message_mentions", ["message_id"])
    op.create_index("ix_message_mentions_group_id", "message_mentions", ["group_id"])
    op.create_index("ix_message_mentions_mentioned_user_id", "message_mentions", ["mentioned_user_id"])


def downgrade() -> None:
    op.drop_index("ix_message_mentions_mentioned_user_id", table_name="message_mentions")
    op.drop_index("ix_message_mentions_group_id", table_name="message_mentions")
    op.drop_index("ix_message_mentions_message_id", table_name="message_mentions")
    op.drop_table("message_mentions")
