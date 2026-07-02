"""create direct and discussion message attachment tables

Revision ID: 20260702_0012
Revises: 20260701_0011
Create Date: 2026-07-02
"""

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

revision = "20260702_0012"
down_revision = "20260701_0011"
branch_labels = None
depends_on = None


def create_attachment_table(table_name: str, message_column: str, message_table: str) -> None:
    op.create_table(
        table_name,
        sa.Column("id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column(message_column, postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("original_filename", sa.String(length=255), nullable=False),
        sa.Column("stored_filename", sa.String(length=255), nullable=False),
        sa.Column("storage_path", sa.String(length=1000), nullable=False),
        sa.Column("content_type", sa.String(length=255), nullable=True),
        sa.Column("size_bytes", sa.Integer(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.ForeignKeyConstraint([message_column], [f"{message_table}.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(f"ix_{table_name}_{message_column}", table_name, [message_column], unique=False)


def upgrade() -> None:
    create_attachment_table("direct_message_attachments", "direct_message_id", "direct_messages")
    create_attachment_table("discussion_message_attachments", "discussion_message_id", "discussion_messages")


def downgrade() -> None:
    for table_name, message_column in (
        ("discussion_message_attachments", "discussion_message_id"),
        ("direct_message_attachments", "direct_message_id"),
    ):
        op.drop_index(f"ix_{table_name}_{message_column}", table_name=table_name)
        op.drop_table(table_name)
