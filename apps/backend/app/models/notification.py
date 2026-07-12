import uuid
from datetime import datetime

from sqlalchemy import Boolean, DateTime, ForeignKey, Index, String, UniqueConstraint, func
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db.base import Base
from app.models.user import User


class Notification(Base):
    __tablename__ = "notifications"
    __table_args__ = (
        UniqueConstraint("dedupe_key", name="uq_notifications_dedupe_key"),
        Index("ix_notifications_user_read", "user_id", "is_read"),
        Index("ix_notifications_user_created", "user_id", "created_at"),
        Index("ix_notifications_category", "category"),
        Index("ix_notifications_source", "source_type", "source_id"),
        Index("ix_notifications_chat", "chat_type", "chat_id"),
        Index("ix_notifications_message_id", "message_id"),
    )

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    user_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"), nullable=False
    )
    type: Mapped[str] = mapped_column(String(64), nullable=False)
    category: Mapped[str] = mapped_column(String(64), nullable=False)
    source_type: Mapped[str | None] = mapped_column(String(64), nullable=True)
    source_id: Mapped[str | None] = mapped_column(String(128), nullable=True)
    chat_type: Mapped[str | None] = mapped_column(String(32), nullable=True)
    chat_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), nullable=True)
    message_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), nullable=True)
    actor_user_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )
    actor_username: Mapped[str | None] = mapped_column(String(64), nullable=True)
    actor_display_name: Mapped[str | None] = mapped_column(String(160), nullable=True)
    title_key: Mapped[str] = mapped_column(String(128), nullable=False)
    body_preview: Mapped[str | None] = mapped_column(String(240), nullable=True)
    meta: Mapped[dict[str, object] | None] = mapped_column("metadata", JSONB, nullable=True)
    dedupe_key: Mapped[str] = mapped_column(String(512), nullable=False)
    is_read: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    read_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    is_dismissed: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    dismissed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )

    user: Mapped[User] = relationship(foreign_keys=[user_id])
    actor: Mapped[User | None] = relationship(foreign_keys=[actor_user_id])


class NotificationPreference(Base):
    __tablename__ = "notification_preferences"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    user_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"), nullable=False, unique=True, index=True
    )
    mentions_enabled: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    replies_enabled: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    reactions_enabled: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    direct_messages_enabled: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    group_messages_enabled: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    discussion_messages_enabled: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    announcements_enabled: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    pins_enabled: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    calendar_events_enabled: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    calendar_reminders_enabled: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    calendar_changes_enabled: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    system_enabled: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    desktop_notifications_enabled: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    sound_enabled: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    quiet_hours_enabled: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    quiet_hours_start: Mapped[str | None] = mapped_column(String(5), nullable=True)
    quiet_hours_end: Mapped[str | None] = mapped_column(String(5), nullable=True)
    timezone: Mapped[str | None] = mapped_column(String(64), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )

    user: Mapped[User] = relationship()
