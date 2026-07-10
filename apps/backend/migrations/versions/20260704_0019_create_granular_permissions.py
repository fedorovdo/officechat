"""create granular permissions

Revision ID: 20260704_0019
Revises: 20260704_0018
Create Date: 2026-07-04
"""

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

revision = "20260704_0019"
down_revision = "20260704_0018"
branch_labels = None
depends_on = None


PERMISSIONS = (
    (
        "can_broadcast",
        "communications",
        "Может отправлять объявления всем пользователям или выбранным аудиториям.",
        "Can send announcements to all users or selected audiences.",
    ),
    (
        "can_pin_messages",
        "messages",
        "Может закреплять и откреплять сообщения в доступных чатах.",
        "Can pin and unpin messages in accessible chats.",
    ),
)


def upgrade() -> None:
    op.create_table(
        "permissions",
        sa.Column("key", sa.String(length=64), nullable=False),
        sa.Column("category", sa.String(length=64), nullable=False),
        sa.Column("description_ru", sa.String(length=500), nullable=False),
        sa.Column("description_en", sa.String(length=500), nullable=False),
        sa.Column("is_active", sa.Boolean(), server_default=sa.text("true"), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.PrimaryKeyConstraint("key"),
    )
    op.create_table(
        "user_permissions",
        sa.Column("id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("user_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("permission_key", sa.String(length=64), nullable=False),
        sa.Column("granted_by_user_id", postgresql.UUID(as_uuid=True), nullable=True),
        sa.Column("granted_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.ForeignKeyConstraint(["granted_by_user_id"], ["users.id"], ondelete="SET NULL"),
        sa.ForeignKeyConstraint(["permission_key"], ["permissions.key"], ondelete="RESTRICT"),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="RESTRICT"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("user_id", "permission_key", name="uq_user_permissions_user_key"),
    )
    op.create_index("ix_user_permissions_user_id", "user_permissions", ["user_id"])
    op.create_index("ix_user_permissions_permission_key", "user_permissions", ["permission_key"])
    op.create_index("ix_user_permissions_granted_by_user_id", "user_permissions", ["granted_by_user_id"])

    for key, category, description_ru, description_en in PERMISSIONS:
        op.execute(
            sa.text(
                """
                INSERT INTO permissions (key, category, description_ru, description_en, is_active)
                VALUES (:key, :category, :description_ru, :description_en, true)
                ON CONFLICT (key) DO UPDATE SET
                    category = EXCLUDED.category,
                    description_ru = EXCLUDED.description_ru,
                    description_en = EXCLUDED.description_en,
                    is_active = true,
                    updated_at = now()
                """
            ).bindparams(
                key=key,
                category=category,
                description_ru=description_ru,
                description_en=description_en,
            )
        )


def downgrade() -> None:
    op.drop_index("ix_user_permissions_granted_by_user_id", table_name="user_permissions")
    op.drop_index("ix_user_permissions_permission_key", table_name="user_permissions")
    op.drop_index("ix_user_permissions_user_id", table_name="user_permissions")
    op.drop_table("user_permissions")
    op.drop_table("permissions")
