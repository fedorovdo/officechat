"""create directory entries

Revision ID: 20260725_0024
Revises: 20260704_0023
Create Date: 2026-07-25 14:00:00.000000
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "20260725_0024"
down_revision: str | None = "20260704_0023"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "directory_entries",
        sa.Column("id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("display_name", sa.String(length=160), nullable=False),
        sa.Column("department", sa.String(length=160), nullable=True),
        sa.Column("position", sa.String(length=160), nullable=True),
        sa.Column("internal_phone", sa.String(length=64), nullable=True),
        sa.Column("work_phone", sa.String(length=64), nullable=True),
        sa.Column("mobile_phone", sa.String(length=64), nullable=True),
        sa.Column("email", sa.String(length=320), nullable=True),
        sa.Column("room", sa.String(length=80), nullable=True),
        sa.Column("location", sa.String(length=255), nullable=True),
        sa.Column("notes", sa.Text(), nullable=True),
        sa.Column("linked_user_id", postgresql.UUID(as_uuid=True), nullable=True),
        sa.Column("is_active", sa.Boolean(), nullable=False, server_default=sa.true()),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.Column("created_by_user_id", postgresql.UUID(as_uuid=True), nullable=True),
        sa.Column("updated_by_user_id", postgresql.UUID(as_uuid=True), nullable=True),
        sa.ForeignKeyConstraint(["created_by_user_id"], ["users.id"], ondelete="SET NULL"),
        sa.ForeignKeyConstraint(["linked_user_id"], ["users.id"], ondelete="SET NULL"),
        sa.ForeignKeyConstraint(["updated_by_user_id"], ["users.id"], ondelete="SET NULL"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_directory_entries_department", "directory_entries", ["department"])
    op.create_index("ix_directory_entries_display_name", "directory_entries", ["display_name"])
    op.create_index("ix_directory_entries_is_active", "directory_entries", ["is_active"])
    op.create_index("ix_directory_entries_linked_user_id", "directory_entries", ["linked_user_id"])

    op.execute(
        sa.text(
            """
            INSERT INTO permissions (key, category, description_ru, description_en, is_active)
            VALUES (
                'can_manage_directory',
                'directory',
                'Может создавать, изменять, архивировать и восстанавливать записи корпоративного справочника.',
                'Can create, edit, archive and restore corporate directory entries.',
                true
            )
            ON CONFLICT (key) DO UPDATE SET
                category = EXCLUDED.category,
                description_ru = EXCLUDED.description_ru,
                description_en = EXCLUDED.description_en,
                is_active = true,
                updated_at = now()
            """
        )
    )


def downgrade() -> None:
    op.execute(
        sa.text("DELETE FROM user_permissions WHERE permission_key = 'can_manage_directory'")
    )
    op.execute(sa.text("DELETE FROM permissions WHERE key = 'can_manage_directory'"))
    op.drop_index("ix_directory_entries_linked_user_id", table_name="directory_entries")
    op.drop_index("ix_directory_entries_is_active", table_name="directory_entries")
    op.drop_index("ix_directory_entries_display_name", table_name="directory_entries")
    op.drop_index("ix_directory_entries_department", table_name="directory_entries")
    op.drop_table("directory_entries")
