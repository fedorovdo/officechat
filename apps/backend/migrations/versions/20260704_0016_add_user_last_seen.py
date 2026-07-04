"""add persistent user last seen timestamp

Revision ID: 20260704_0016
Revises: 20260704_0015
Create Date: 2026-07-04
"""

from alembic import op
import sqlalchemy as sa

revision = "20260704_0016"
down_revision = "20260704_0015"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("users", sa.Column("last_seen_at", sa.DateTime(timezone=True), nullable=True))


def downgrade() -> None:
    op.drop_column("users", "last_seen_at")
