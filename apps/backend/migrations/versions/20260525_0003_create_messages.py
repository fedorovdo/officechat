"""create messages table

Revision ID: 20260525_0003
Revises: 20260525_0002
Create Date: 2026-05-25
"""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

revision = "20260525_0003"
down_revision = "20260525_0002"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "messages",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True, nullable=False),
        sa.Column("group_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("sender_user_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("body", sa.Text(), nullable=False),
        sa.Column("message_type", sa.String(length=32), nullable=False, server_default="text"),
        sa.Column("is_deleted", sa.Boolean(), nullable=False, server_default=sa.text("false")),
        sa.Column("edited_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.ForeignKeyConstraint(["group_id"], ["groups.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["sender_user_id"], ["users.id"], ondelete="CASCADE"),
    )
    op.create_index("ix_messages_group_id", "messages", ["group_id"])
    op.create_index("ix_messages_sender_user_id", "messages", ["sender_user_id"])
    op.create_index("ix_messages_group_created_at", "messages", ["group_id", "created_at"])


def downgrade() -> None:
    op.drop_index("ix_messages_group_created_at", table_name="messages")
    op.drop_index("ix_messages_sender_user_id", table_name="messages")
    op.drop_index("ix_messages_group_id", table_name="messages")
    op.drop_table("messages")
