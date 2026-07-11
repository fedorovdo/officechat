import uuid
from datetime import datetime

from sqlalchemy import CheckConstraint, DateTime, ForeignKey, Index, Integer, String, Text, UniqueConstraint, func
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db.base import Base
from app.models.user import User

BROADCAST_PRIORITIES = ("normal", "important", "urgent")
BROADCAST_STATUSES = ("draft", "sending", "sent", "failed", "partially_failed", "retracted")
BROADCAST_AUDIENCE_TYPES = ("all_active_users", "selected_groups", "selected_users")
BROADCAST_RECIPIENT_STATUSES = ("pending", "notified", "offline", "failed")


class BroadcastAnnouncement(Base):
    __tablename__ = "broadcast_announcements"
    __table_args__ = (
        CheckConstraint(f"priority IN {BROADCAST_PRIORITIES}", name="ck_broadcast_announcements_priority"),
        CheckConstraint(f"status IN {BROADCAST_STATUSES}", name="ck_broadcast_announcements_status"),
        CheckConstraint(f"audience_type IN {BROADCAST_AUDIENCE_TYPES}", name="ck_broadcast_announcements_audience_type"),
        UniqueConstraint("idempotency_key", name="uq_broadcast_announcements_idempotency_key"),
        Index("ix_broadcast_announcements_status", "status"),
        Index("ix_broadcast_announcements_sent_at", "sent_at"),
        Index("ix_broadcast_announcements_created_by_user_id", "created_by_user_id"),
    )

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    created_by_user_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )
    created_by_username: Mapped[str] = mapped_column(String(64), nullable=False)
    created_by_display_name: Mapped[str] = mapped_column(String(160), nullable=False)
    title: Mapped[str] = mapped_column(String(160), nullable=False)
    body: Mapped[str] = mapped_column(Text, nullable=False)
    priority: Mapped[str] = mapped_column(String(32), nullable=False, default="normal")
    status: Mapped[str] = mapped_column(String(32), nullable=False, default="draft")
    audience_type: Mapped[str] = mapped_column(String(32), nullable=False)
    audience_definition: Mapped[dict[str, object] | None] = mapped_column(JSONB, nullable=True)
    recipient_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    notified_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    read_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    failed_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    idempotency_key: Mapped[str | None] = mapped_column(String(128), nullable=True)
    sent_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    expires_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    retracted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now())

    created_by: Mapped[User | None] = relationship()
    recipients: Mapped[list["BroadcastRecipient"]] = relationship(
        back_populates="broadcast",
        cascade="all, delete-orphan",
    )


class BroadcastRecipient(Base):
    __tablename__ = "broadcast_recipients"
    __table_args__ = (
        UniqueConstraint("broadcast_id", "user_id", name="uq_broadcast_recipients_broadcast_user"),
        CheckConstraint(
            f"notification_status IN {BROADCAST_RECIPIENT_STATUSES}",
            name="ck_broadcast_recipients_notification_status",
        ),
        Index("ix_broadcast_recipients_broadcast_id", "broadcast_id"),
        Index("ix_broadcast_recipients_user_read", "user_id", "read_at"),
    )

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    broadcast_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("broadcast_announcements.id", ondelete="CASCADE"), nullable=False
    )
    user_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )
    username_snapshot: Mapped[str] = mapped_column(String(64), nullable=False)
    display_name_snapshot: Mapped[str] = mapped_column(String(160), nullable=False)
    notification_status: Mapped[str] = mapped_column(String(32), nullable=False, default="pending")
    notified_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    read_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    dismissed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    error_code: Mapped[str | None] = mapped_column(String(64), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now())

    broadcast: Mapped[BroadcastAnnouncement] = relationship(back_populates="recipients")
    user: Mapped[User | None] = relationship()
