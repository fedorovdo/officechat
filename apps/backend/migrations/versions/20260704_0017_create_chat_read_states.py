"""create high-water chat read states

Revision ID: 20260704_0017
Revises: 20260704_0016
Create Date: 2026-07-04
"""

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

revision = "20260704_0017"
down_revision = "20260704_0016"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "chat_read_states",
        sa.Column("id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("user_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("chat_type", sa.String(length=24), nullable=False),
        sa.Column("chat_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("last_read_message_id", postgresql.UUID(as_uuid=True), nullable=True),
        sa.Column("last_read_message_created_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("last_read_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.CheckConstraint("chat_type IN ('group', 'direct', 'discussion')", name="ck_chat_read_states_type_allowed"),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("user_id", "chat_type", "chat_id", name="uq_chat_read_states_user_chat"),
    )
    op.create_index("ix_chat_read_states_user_id", "chat_read_states", ["user_id"])
    op.create_index("ix_chat_read_states_chat", "chat_read_states", ["chat_type", "chat_id"])
    op.create_index(
        "ix_chat_read_states_user_chat", "chat_read_states", ["user_id", "chat_type", "chat_id"]
    )
    op.create_index("ix_chat_read_states_updated_at", "chat_read_states", ["updated_at"])

    # Existing history is read at deployment. One row is created per accessible chat, never per message.
    op.execute("""
        INSERT INTO chat_read_states
            (id, user_id, chat_type, chat_id, last_read_message_id,
             last_read_message_created_at, last_read_at, created_at, updated_at)
        SELECT gen_random_uuid(), gm.user_id, 'group', gm.group_id,
               latest.id, latest.created_at, now(), now(), now()
        FROM group_members gm
        LEFT JOIN LATERAL (
            SELECT m.id, m.created_at FROM messages m
            WHERE m.group_id = gm.group_id
            ORDER BY m.created_at DESC, m.id DESC LIMIT 1
        ) latest ON true
        ON CONFLICT (user_id, chat_type, chat_id) DO NOTHING
    """)
    op.execute("""
        INSERT INTO chat_read_states
            (id, user_id, chat_type, chat_id, last_read_message_id,
             last_read_message_created_at, last_read_at, created_at, updated_at)
        SELECT gen_random_uuid(), participants.user_id, 'direct', participants.chat_id,
               latest.id, latest.created_at, now(), now(), now()
        FROM (
            SELECT id AS chat_id, user_one_id AS user_id FROM direct_conversations
            UNION ALL
            SELECT id AS chat_id, user_two_id AS user_id FROM direct_conversations
        ) participants
        LEFT JOIN LATERAL (
            SELECT dm.id, dm.created_at FROM direct_messages dm
            WHERE dm.conversation_id = participants.chat_id
            ORDER BY dm.created_at DESC, dm.id DESC LIMIT 1
        ) latest ON true
        ON CONFLICT (user_id, chat_type, chat_id) DO NOTHING
    """)
    op.execute("""
        INSERT INTO chat_read_states
            (id, user_id, chat_type, chat_id, last_read_message_id,
             last_read_message_created_at, last_read_at, created_at, updated_at)
        SELECT gen_random_uuid(), dm.user_id, 'discussion', dm.discussion_id,
               latest.id, latest.created_at, now(), now(), now()
        FROM discussion_members dm
        LEFT JOIN LATERAL (
            SELECT msg.id, msg.created_at FROM discussion_messages msg
            WHERE msg.discussion_id = dm.discussion_id
            ORDER BY msg.created_at DESC, msg.id DESC LIMIT 1
        ) latest ON true
        ON CONFLICT (user_id, chat_type, chat_id) DO NOTHING
    """)


def downgrade() -> None:
    op.drop_index("ix_chat_read_states_updated_at", table_name="chat_read_states")
    op.drop_index("ix_chat_read_states_user_chat", table_name="chat_read_states")
    op.drop_index("ix_chat_read_states_chat", table_name="chat_read_states")
    op.drop_index("ix_chat_read_states_user_id", table_name="chat_read_states")
    op.drop_table("chat_read_states")
