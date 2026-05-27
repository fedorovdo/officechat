"""create direct message tables

Revision ID: 20260525_0006
Revises: 20260525_0005
Create Date: 2026-05-25
"""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

revision = "20260525_0006"
down_revision = "20260525_0005"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "direct_conversations",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True, nullable=False),
        sa.Column("user_one_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("user_two_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.CheckConstraint("user_one_id <> user_two_id", name="ck_direct_conversations_distinct_users"),
        sa.ForeignKeyConstraint(["user_one_id"], ["users.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["user_two_id"], ["users.id"], ondelete="CASCADE"),
        sa.UniqueConstraint("user_one_id", "user_two_id", name="uq_direct_conversations_pair"),
    )
    op.create_index("ix_direct_conversations_user_one_id", "direct_conversations", ["user_one_id"])
    op.create_index("ix_direct_conversations_user_two_id", "direct_conversations", ["user_two_id"])

    op.create_table(
        "direct_messages",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True, nullable=False),
        sa.Column("conversation_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("sender_user_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("body", sa.Text(), nullable=False),
        sa.Column("message_type", sa.String(length=32), nullable=False, server_default="text"),
        sa.Column("is_deleted", sa.Boolean(), nullable=False, server_default=sa.text("false")),
        sa.Column("edited_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.ForeignKeyConstraint(["conversation_id"], ["direct_conversations.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["sender_user_id"], ["users.id"], ondelete="CASCADE"),
    )
    op.create_index("ix_direct_messages_conversation_id", "direct_messages", ["conversation_id"])
    op.create_index("ix_direct_messages_sender_user_id", "direct_messages", ["sender_user_id"])


def downgrade() -> None:
    op.drop_index("ix_direct_messages_sender_user_id", table_name="direct_messages")
    op.drop_index("ix_direct_messages_conversation_id", table_name="direct_messages")
    op.drop_table("direct_messages")
    op.drop_index("ix_direct_conversations_user_two_id", table_name="direct_conversations")
    op.drop_index("ix_direct_conversations_user_one_id", table_name="direct_conversations")
    op.drop_table("direct_conversations")
