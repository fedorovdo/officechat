"""add deterministic attachment ordering

Revision ID: 20260703_0013
Revises: 20260702_0012
Create Date: 2026-07-03
"""

from alembic import op
import sqlalchemy as sa

revision = "20260703_0013"
down_revision = "20260702_0012"
branch_labels = None
depends_on = None

ATTACHMENT_TABLES = (
    "message_attachments",
    "direct_message_attachments",
    "discussion_message_attachments",
)


def upgrade() -> None:
    for table_name in ATTACHMENT_TABLES:
        op.add_column(
            table_name,
            sa.Column("sort_order", sa.Integer(), server_default="0", nullable=False),
        )


def downgrade() -> None:
    for table_name in reversed(ATTACHMENT_TABLES):
        op.drop_column(table_name, "sort_order")
