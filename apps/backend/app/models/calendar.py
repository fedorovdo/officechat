import uuid
from datetime import date, datetime

from sqlalchemy import Boolean, CheckConstraint, Date, DateTime, ForeignKey, Index, Integer, String, Text, UniqueConstraint, func
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db.base import Base
from app.models.user import User

CALENDAR_EVENT_TYPES = ("meeting", "video_conference", "office_event", "training", "maintenance", "other")
CALENDAR_EVENT_STATUSES = ("scheduled", "rescheduled", "cancelled", "completed")
CALENDAR_AUDIENCE_TYPES = ("all_active_users", "selected_groups", "selected_users")
CALENDAR_RECIPIENT_SOURCE_TYPES = ("all_users", "group", "individual")
CALENDAR_REMINDER_STATUSES = ("pending", "delivered", "skipped", "failed")


class CalendarEvent(Base):
    __tablename__ = "calendar_events"
    __table_args__ = (
        CheckConstraint(f"event_type IN {CALENDAR_EVENT_TYPES}", name="ck_calendar_events_event_type"),
        CheckConstraint(f"status IN {CALENDAR_EVENT_STATUSES}", name="ck_calendar_events_status"),
        CheckConstraint(f"audience_type IN {CALENDAR_AUDIENCE_TYPES}", name="ck_calendar_events_audience_type"),
        CheckConstraint(
            "(is_all_day = true AND all_day_start_date IS NOT NULL AND all_day_end_date IS NOT NULL "
            "AND starts_at IS NULL AND ends_at IS NULL AND all_day_end_date >= all_day_start_date) "
            "OR (is_all_day = false AND starts_at IS NOT NULL AND ends_at IS NOT NULL AND ends_at > starts_at "
            "AND all_day_start_date IS NULL AND all_day_end_date IS NULL)",
            name="ck_calendar_events_time_shape",
        ),
        Index("ix_calendar_events_starts_at", "starts_at"),
        Index("ix_calendar_events_ends_at", "ends_at"),
        Index("ix_calendar_events_all_day_start_date", "all_day_start_date"),
        Index("ix_calendar_events_all_day_end_date", "all_day_end_date"),
        Index("ix_calendar_events_status", "status"),
        Index("ix_calendar_events_created_by_user_id", "created_by_user_id"),
        Index("ix_calendar_events_event_type", "event_type"),
    )

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    title: Mapped[str] = mapped_column(String(200), nullable=False)
    description: Mapped[str | None] = mapped_column(Text, nullable=True)
    event_type: Mapped[str] = mapped_column(String(32), nullable=False)
    status: Mapped[str] = mapped_column(String(32), nullable=False, default="scheduled")
    starts_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    ends_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    is_all_day: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    all_day_start_date: Mapped[date | None] = mapped_column(Date, nullable=True)
    all_day_end_date: Mapped[date | None] = mapped_column(Date, nullable=True)
    timezone: Mapped[str] = mapped_column(String(64), nullable=False)
    location: Mapped[str | None] = mapped_column(String(500), nullable=True)
    conference_url: Mapped[str | None] = mapped_column(String(1000), nullable=True)
    audience_type: Mapped[str] = mapped_column(String(32), nullable=False)
    audience_definition: Mapped[dict[str, object] | None] = mapped_column(JSONB, nullable=True)
    created_by_user_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )
    created_by_username: Mapped[str | None] = mapped_column(String(64), nullable=True)
    created_by_display_name: Mapped[str | None] = mapped_column(String(160), nullable=True)
    cancelled_by_user_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )
    cancelled_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    cancellation_reason: Mapped[str | None] = mapped_column(String(1000), nullable=True)
    reminder_minutes: Mapped[list[int] | None] = mapped_column(JSONB, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), nullable=False)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now(), nullable=False)

    created_by: Mapped[User | None] = relationship(foreign_keys=[created_by_user_id])
    cancelled_by: Mapped[User | None] = relationship(foreign_keys=[cancelled_by_user_id])
    recipients: Mapped[list["CalendarEventRecipient"]] = relationship(
        back_populates="event",
        cascade="all, delete-orphan",
    )


class CalendarEventRecipient(Base):
    __tablename__ = "calendar_event_recipients"
    __table_args__ = (
        UniqueConstraint("event_id", "user_id", name="uq_calendar_event_recipients_event_user"),
        CheckConstraint(
            f"source_type IN {CALENDAR_RECIPIENT_SOURCE_TYPES}",
            name="ck_calendar_event_recipients_source_type",
        ),
        Index("ix_calendar_event_recipients_event_id", "event_id"),
        Index("ix_calendar_event_recipients_user_id", "user_id"),
        Index("ix_calendar_event_recipients_user_event", "user_id", "event_id"),
    )

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    event_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("calendar_events.id", ondelete="CASCADE"), nullable=False
    )
    user_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )
    username_snapshot: Mapped[str | None] = mapped_column(String(64), nullable=True)
    display_name_snapshot: Mapped[str | None] = mapped_column(String(160), nullable=True)
    source_type: Mapped[str] = mapped_column(String(32), nullable=False)
    source_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), nullable=False)

    event: Mapped[CalendarEvent] = relationship(back_populates="recipients")
    user: Mapped[User | None] = relationship()


class CalendarReminderDelivery(Base):
    __tablename__ = "calendar_reminder_deliveries"
    __table_args__ = (
        UniqueConstraint(
            "event_id",
            "user_id",
            "reminder_minutes",
            "scheduled_for",
            name="uq_calendar_reminder_deliveries_event_user_minute_time",
        ),
        CheckConstraint(
            f"status IN {CALENDAR_REMINDER_STATUSES}",
            name="ck_calendar_reminder_deliveries_status",
        ),
        Index("ix_calendar_reminder_deliveries_due", "status", "scheduled_for"),
        Index("ix_calendar_reminder_deliveries_event_id", "event_id"),
        Index("ix_calendar_reminder_deliveries_user_id", "user_id"),
    )

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    event_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("calendar_events.id", ondelete="CASCADE"), nullable=False
    )
    user_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"), nullable=False
    )
    reminder_minutes: Mapped[int] = mapped_column(Integer, nullable=False)
    scheduled_for: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    delivered_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    status: Mapped[str] = mapped_column(String(32), nullable=False, default="pending")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), nullable=False)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now(), nullable=False)

    event: Mapped[CalendarEvent] = relationship()
    user: Mapped[User] = relationship()
