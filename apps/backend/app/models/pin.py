import uuid
from datetime import datetime

from sqlalchemy import CheckConstraint, DateTime, ForeignKey, Index, String, UniqueConstraint, func
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db.base import Base
from app.models.user import User

PIN_CHAT_TYPES = ("group", "direct", "discussion")


class PinnedMessage(Base):
    __tablename__ = "pinned_messages"
    __table_args__ = (
        UniqueConstraint("chat_type", "chat_id", "message_id", name="uq_pinned_messages_chat_message"),
        CheckConstraint(f"chat_type IN {PIN_CHAT_TYPES}", name="ck_pinned_messages_chat_type_allowed"),
        Index("ix_pinned_messages_chat", "chat_type", "chat_id"),
        Index("ix_pinned_messages_message_id", "message_id"),
        Index("ix_pinned_messages_pinned_at", "pinned_at"),
        Index("ix_pinned_messages_pinned_by_user_id", "pinned_by_user_id"),
    )

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    chat_type: Mapped[str] = mapped_column(String(32), nullable=False)
    chat_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False)
    message_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False)
    pinned_by_user_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )
    pinned_by_username: Mapped[str] = mapped_column(String(64), nullable=False)
    pinned_by_display_name: Mapped[str] = mapped_column(String(160), nullable=False)
    pinned_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), nullable=False)
    note: Mapped[str | None] = mapped_column(String(300), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), nullable=False)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now(), nullable=False
    )

    pinned_by: Mapped[User | None] = relationship()
