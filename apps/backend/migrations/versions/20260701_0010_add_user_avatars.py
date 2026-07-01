"""add user avatar metadata

Revision ID: 20260701_0010
Revises: 20260602_0009
Create Date: 2026-07-01
"""

from alembic import op
import sqlalchemy as sa

revision = "20260701_0010"
down_revision = "20260602_0009"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("users", sa.Column("avatar_path", sa.String(length=512), nullable=True))
    op.add_column("users", sa.Column("avatar_content_type", sa.String(length=128), nullable=True))
    op.add_column("users", sa.Column("avatar_updated_at", sa.DateTime(timezone=True), nullable=True))


def downgrade() -> None:
    op.drop_column("users", "avatar_updated_at")
    op.drop_column("users", "avatar_content_type")
    op.drop_column("users", "avatar_path")
