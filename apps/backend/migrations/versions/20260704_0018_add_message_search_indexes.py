"""add mixed-language message search indexes

Revision ID: 20260704_0018
Revises: 20260704_0017
Create Date: 2026-07-04
"""

from alembic import op

revision = "20260704_0018"
down_revision = "20260704_0017"
branch_labels = None
depends_on = None


SEARCH_INDEXES = {
    "ix_messages_body_search": ("messages", "body"),
    "ix_direct_messages_body_search": ("direct_messages", "body"),
    "ix_discussion_messages_body_search": ("discussion_messages", "body"),
    "ix_message_attachments_name_search": ("message_attachments", "original_filename"),
    "ix_direct_message_attachments_name_search": (
        "direct_message_attachments",
        "original_filename",
    ),
    "ix_discussion_message_attachments_name_search": (
        "discussion_message_attachments",
        "original_filename",
    ),
}


def upgrade() -> None:
    for index_name, (table_name, column_name) in SEARCH_INDEXES.items():
        op.execute(
            f"CREATE INDEX {index_name} ON {table_name} "
            f"USING gin (to_tsvector('simple'::regconfig, coalesce({column_name}, '')))"
        )


def downgrade() -> None:
    for index_name in reversed(SEARCH_INDEXES):
        op.execute(f"DROP INDEX IF EXISTS {index_name}")

