"""create pinned messages

Revision ID: 20260704_0020
Revises: 20260704_0019
Create Date: 2026-07-04
"""

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

revision = "20260704_0020"
down_revision = "20260704_0019"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "pinned_messages",
        sa.Column("id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("chat_type", sa.String(length=32), nullable=False),
        sa.Column("chat_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("message_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("pinned_by_user_id", postgresql.UUID(as_uuid=True), nullable=True),
        sa.Column("pinned_by_username", sa.String(length=64), nullable=False),
        sa.Column("pinned_by_display_name", sa.String(length=160), nullable=False),
        sa.Column("pinned_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column("note", sa.String(length=300), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.CheckConstraint("chat_type IN ('group', 'direct', 'discussion')", name="ck_pinned_messages_chat_type_allowed"),
        sa.ForeignKeyConstraint(["pinned_by_user_id"], ["users.id"], ondelete="SET NULL"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("chat_type", "chat_id", "message_id", name="uq_pinned_messages_chat_message"),
    )
    op.create_index("ix_pinned_messages_chat", "pinned_messages", ["chat_type", "chat_id"])
    op.create_index("ix_pinned_messages_message_id", "pinned_messages", ["message_id"])
    op.create_index("ix_pinned_messages_pinned_at", "pinned_messages", ["pinned_at"])
    op.create_index("ix_pinned_messages_pinned_by_user_id", "pinned_messages", ["pinned_by_user_id"])


def downgrade() -> None:
    op.drop_index("ix_pinned_messages_pinned_by_user_id", table_name="pinned_messages")
    op.drop_index("ix_pinned_messages_pinned_at", table_name="pinned_messages")
    op.drop_index("ix_pinned_messages_message_id", table_name="pinned_messages")
    op.drop_index("ix_pinned_messages_chat", table_name="pinned_messages")
    op.drop_table("pinned_messages")
