"""create discussions tables

Revision ID: 20260602_0009
Revises: 20260602_0008
Create Date: 2026-06-02
"""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

revision = "20260602_0009"
down_revision = "20260602_0008"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "discussions",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True, nullable=False),
        sa.Column("source_group_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("source_message_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("title", sa.String(length=255), nullable=True),
        sa.Column("created_by_user_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("is_active", sa.Boolean(), nullable=False, server_default=sa.true()),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.ForeignKeyConstraint(["source_group_id"], ["groups.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["source_message_id"], ["messages.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["created_by_user_id"], ["users.id"], ondelete="CASCADE"),
        sa.UniqueConstraint("source_message_id", name="uq_discussions_source_message_id"),
    )
    op.create_index("ix_discussions_source_group_id", "discussions", ["source_group_id"])
    op.create_index("ix_discussions_source_message_id", "discussions", ["source_message_id"], unique=True)
    op.create_index("ix_discussions_created_by_user_id", "discussions", ["created_by_user_id"])

    op.create_table(
        "discussion_members",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True, nullable=False),
        sa.Column("discussion_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("user_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("role", sa.String(length=32), nullable=False, server_default="member"),
        sa.Column("joined_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.CheckConstraint("role IN ('owner', 'member')", name="ck_discussion_members_role_allowed"),
        sa.ForeignKeyConstraint(["discussion_id"], ["discussions.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="CASCADE"),
        sa.UniqueConstraint("discussion_id", "user_id", name="uq_discussion_members_discussion_user"),
    )
    op.create_index("ix_discussion_members_discussion_id", "discussion_members", ["discussion_id"])
    op.create_index("ix_discussion_members_user_id", "discussion_members", ["user_id"])

    op.create_table(
        "discussion_messages",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True, nullable=False),
        sa.Column("discussion_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("sender_user_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("body", sa.Text(), nullable=False),
        sa.Column("is_deleted", sa.Boolean(), nullable=False, server_default=sa.false()),
        sa.Column("edited_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.ForeignKeyConstraint(["discussion_id"], ["discussions.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["sender_user_id"], ["users.id"], ondelete="CASCADE"),
    )
    op.create_index("ix_discussion_messages_discussion_id", "discussion_messages", ["discussion_id"])
    op.create_index("ix_discussion_messages_sender_user_id", "discussion_messages", ["sender_user_id"])


def downgrade() -> None:
    op.drop_index("ix_discussion_messages_sender_user_id", table_name="discussion_messages")
    op.drop_index("ix_discussion_messages_discussion_id", table_name="discussion_messages")
    op.drop_table("discussion_messages")

    op.drop_index("ix_discussion_members_user_id", table_name="discussion_members")
    op.drop_index("ix_discussion_members_discussion_id", table_name="discussion_members")
    op.drop_table("discussion_members")

    op.drop_index("ix_discussions_created_by_user_id", table_name="discussions")
    op.drop_index("ix_discussions_source_message_id", table_name="discussions")
    op.drop_index("ix_discussions_source_group_id", table_name="discussions")
    op.drop_table("discussions")
