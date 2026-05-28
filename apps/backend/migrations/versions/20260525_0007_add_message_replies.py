"""add message reply references

Revision ID: 20260525_0007
Revises: 20260525_0006
Create Date: 2026-05-28
"""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

revision = "20260525_0007"
down_revision = "20260525_0006"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("messages", sa.Column("reply_to_message_id", postgresql.UUID(as_uuid=True), nullable=True))
    op.create_foreign_key(
        "fk_messages_reply_to_message_id_messages",
        "messages",
        "messages",
        ["reply_to_message_id"],
        ["id"],
        ondelete="SET NULL",
    )
    op.create_index("ix_messages_reply_to_message_id", "messages", ["reply_to_message_id"])

    op.add_column("direct_messages", sa.Column("reply_to_message_id", postgresql.UUID(as_uuid=True), nullable=True))
    op.create_foreign_key(
        "fk_direct_messages_reply_to_message_id_direct_messages",
        "direct_messages",
        "direct_messages",
        ["reply_to_message_id"],
        ["id"],
        ondelete="SET NULL",
    )
    op.create_index("ix_direct_messages_reply_to_message_id", "direct_messages", ["reply_to_message_id"])


def downgrade() -> None:
    op.drop_index("ix_direct_messages_reply_to_message_id", table_name="direct_messages")
    op.drop_constraint(
        "fk_direct_messages_reply_to_message_id_direct_messages",
        "direct_messages",
        type_="foreignkey",
    )
    op.drop_column("direct_messages", "reply_to_message_id")

    op.drop_index("ix_messages_reply_to_message_id", table_name="messages")
    op.drop_constraint("fk_messages_reply_to_message_id_messages", "messages", type_="foreignkey")
    op.drop_column("messages", "reply_to_message_id")
