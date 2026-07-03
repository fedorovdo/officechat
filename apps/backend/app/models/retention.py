import uuid
from datetime import datetime

from sqlalchemy import Boolean, DateTime, ForeignKey, Integer, JSON, String, func
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db.base import Base
from app.models.user import User


class RetentionSettings(Base):
    __tablename__ = "retention_settings"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, default=1)
    retention_enabled: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    active_history_days: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    archive_enabled: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    attachment_retention_days: Mapped[int | None] = mapped_column(Integer, nullable=True)
    delete_archived_after_days: Mapped[int | None] = mapped_column(Integer, nullable=True)
    cleanup_batch_size: Mapped[int] = mapped_column(Integer, nullable=False, default=500)
    cleanup_interval_hours: Mapped[int] = mapped_column(Integer, nullable=False, default=24)
    last_cleanup_started_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    last_cleanup_finished_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    last_cleanup_status: Mapped[str | None] = mapped_column(String(32), nullable=True)
    last_cleanup_summary: Mapped[dict | None] = mapped_column(JSON, nullable=True)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )
    updated_by_user_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )

    updated_by: Mapped[User | None] = relationship()


class RetentionAudit(Base):
    __tablename__ = "retention_audit"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    action: Mapped[str] = mapped_column(String(64), nullable=False, index=True)
    actor_user_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id", ondelete="SET NULL"), nullable=True, index=True
    )
    details: Mapped[dict] = mapped_column(JSON, nullable=False, default=dict)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())

    actor: Mapped[User | None] = relationship()
