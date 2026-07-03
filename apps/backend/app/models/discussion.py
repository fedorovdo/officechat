import uuid
from datetime import datetime

from sqlalchemy import Boolean, CheckConstraint, DateTime, ForeignKey, String, Text, UniqueConstraint, func
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db.base import Base
from app.models.group import Group
from app.models.message import Message
from app.models.user import User

DISCUSSION_MEMBER_ROLES = ("owner", "member")


class Discussion(Base):
    __tablename__ = "discussions"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    source_group_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("groups.id", ondelete="CASCADE"), nullable=False, index=True
    )
    source_message_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("messages.id", ondelete="CASCADE"), nullable=False, unique=True, index=True
    )
    title: Mapped[str | None] = mapped_column(String(255), nullable=True)
    created_by_user_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True
    )
    is_active: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )

    source_group: Mapped[Group] = relationship()
    source_message: Mapped[Message] = relationship()
    created_by: Mapped[User] = relationship()
    members: Mapped[list["DiscussionMember"]] = relationship(
        back_populates="discussion",
        cascade="all, delete-orphan",
    )
    messages: Mapped[list["DiscussionMessage"]] = relationship(
        back_populates="discussion",
        cascade="all, delete-orphan",
    )


class DiscussionMember(Base):
    __tablename__ = "discussion_members"
    __table_args__ = (
        UniqueConstraint("discussion_id", "user_id", name="uq_discussion_members_discussion_user"),
        CheckConstraint(f"role IN {DISCUSSION_MEMBER_ROLES}", name="ck_discussion_members_role_allowed"),
    )

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    discussion_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("discussions.id", ondelete="CASCADE"), nullable=False, index=True
    )
    user_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True
    )
    role: Mapped[str] = mapped_column(String(32), nullable=False, default="member")
    joined_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())

    discussion: Mapped[Discussion] = relationship(back_populates="members")
    user: Mapped[User] = relationship()


class DiscussionMessage(Base):
    __tablename__ = "discussion_messages"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    discussion_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("discussions.id", ondelete="CASCADE"), nullable=False, index=True
    )
    sender_user_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True
    )
    body: Mapped[str] = mapped_column(Text, nullable=False)
    is_deleted: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    edited_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )

    discussion: Mapped[Discussion] = relationship(back_populates="messages")
    sender: Mapped[User] = relationship()
    reactions: Mapped[list["DiscussionMessageReaction"]] = relationship(
        back_populates="message",
        cascade="all, delete-orphan",
    )
    attachments: Mapped[list["DiscussionMessageAttachment"]] = relationship(
        back_populates="discussion_message",
        cascade="all, delete-orphan",
        order_by="DiscussionMessageAttachment.sort_order",
    )
