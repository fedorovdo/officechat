import uuid
from datetime import datetime

from sqlalchemy import CheckConstraint, DateTime, ForeignKey, Index, String, UniqueConstraint, func
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base

CHAT_TYPES = ("group", "direct", "discussion")


class ChatReadState(Base):
    __tablename__ = "chat_read_states"
    __table_args__ = (
        CheckConstraint(f"chat_type IN {CHAT_TYPES}", name="ck_chat_read_states_type_allowed"),
        UniqueConstraint("user_id", "chat_type", "chat_id", name="uq_chat_read_states_user_chat"),
        Index("ix_chat_read_states_chat", "chat_type", "chat_id"),
        Index("ix_chat_read_states_user_chat", "user_id", "chat_type", "chat_id"),
        Index("ix_chat_read_states_updated_at", "updated_at"),
    )

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    user_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True
    )
    chat_type: Mapped[str] = mapped_column(String(24), nullable=False)
    chat_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False)
    last_read_message_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), nullable=True)
    last_read_message_created_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    last_read_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )
