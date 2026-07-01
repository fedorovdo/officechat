"""create message reaction tables

Revision ID: 20260701_0011
Revises: 20260701_0010
Create Date: 2026-07-01
"""

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

revision = "20260701_0011"
down_revision = "20260701_0010"
branch_labels = None
depends_on = None


def create_reaction_table(table_name: str, message_table: str, unique_name: str) -> None:
    op.create_table(
        table_name,
        sa.Column("id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("message_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("user_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("emoji", sa.String(length=16), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.ForeignKeyConstraint(["message_id"], [f"{message_table}.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("message_id", "user_id", "emoji", name=unique_name),
    )
    op.create_index(f"ix_{table_name}_message_id", table_name, ["message_id"], unique=False)
    op.create_index(f"ix_{table_name}_user_id", table_name, ["user_id"], unique=False)


def upgrade() -> None:
    create_reaction_table(
        "group_message_reactions", "messages", "uq_group_message_reactions_message_user_emoji"
    )
    create_reaction_table(
        "direct_message_reactions", "direct_messages", "uq_direct_message_reactions_message_user_emoji"
    )
    create_reaction_table(
        "discussion_message_reactions",
        "discussion_messages",
        "uq_discussion_message_reactions_message_user_emoji",
    )


def downgrade() -> None:
    for table_name in (
        "discussion_message_reactions",
        "direct_message_reactions",
        "group_message_reactions",
    ):
        op.drop_index(f"ix_{table_name}_user_id", table_name=table_name)
        op.drop_index(f"ix_{table_name}_message_id", table_name=table_name)
        op.drop_table(table_name)
