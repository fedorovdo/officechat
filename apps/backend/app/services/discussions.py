from datetime import datetime, timezone
from uuid import UUID

from fastapi import UploadFile
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.models.attachment import DiscussionMessageAttachment
from app.models.discussion import Discussion, DiscussionMember, DiscussionMessage
from app.models.group import GroupMember
from app.models.message import Message
from app.models.reaction import DiscussionMessageReaction
from app.models.user import User
from app.schemas.discussion import DiscussionCreate, DiscussionMemberCreate, DiscussionMessageCreate, DiscussionMessageUpdate
from app.services.attachments import remove_saved_file, save_uploads, validate_attachment_message_body
from app.services.groups import get_group, get_group_membership, is_global_group_admin
from app.services.messages import DELETED_MESSAGE_BODY, ensure_group_message_access, get_group_message, validate_message_body
from app.services.users import get_user_by_username


def normalize_discussion_invite_username(username: str) -> str:
    normalized_username = username.strip()
    if normalized_username.startswith("@"):
        normalized_username = normalized_username[1:].strip()
    return normalized_username


async def get_discussion(session: AsyncSession, discussion_id: UUID) -> Discussion | None:
    result = await session.execute(
        select(Discussion)
        .options(
            selectinload(Discussion.source_group),
            selectinload(Discussion.source_message).selectinload(Message.sender),
            selectinload(Discussion.members).selectinload(DiscussionMember.user),
        )
        .where(Discussion.id == discussion_id)
    )
    return result.scalar_one_or_none()


async def get_discussion_by_source_message(session: AsyncSession, source_message_id: UUID) -> Discussion | None:
    result = await session.execute(
        select(Discussion)
        .options(
            selectinload(Discussion.source_group),
            selectinload(Discussion.source_message).selectinload(Message.sender),
            selectinload(Discussion.members).selectinload(DiscussionMember.user),
        )
        .where(Discussion.source_message_id == source_message_id, Discussion.is_active.is_(True))
    )
    return result.scalar_one_or_none()


async def get_discussion_membership(
    session: AsyncSession,
    discussion_id: UUID,
    user_id: UUID,
) -> DiscussionMember | None:
    result = await session.execute(
        select(DiscussionMember).where(
            DiscussionMember.discussion_id == discussion_id,
            DiscussionMember.user_id == user_id,
        )
    )
    return result.scalar_one_or_none()


async def ensure_discussion_access(session: AsyncSession, discussion: Discussion, current_user: User) -> None:
    if not current_user.is_active:
        raise PermissionError("Active user required")
    if not discussion.is_active or not discussion.source_group.is_active:
        raise PermissionError("Discussion is inactive")
    if await get_discussion_membership(session, discussion.id, current_user.id) is None:
        raise PermissionError("Discussion membership required")


async def can_manage_discussion_members(session: AsyncSession, discussion: Discussion, current_user: User) -> bool:
    if is_global_group_admin(current_user):
        return True
    discussion_membership = await get_discussion_membership(session, discussion.id, current_user.id)
    if discussion_membership is not None and discussion_membership.role == "owner":
        return True
    group_membership = await get_group_membership(session, discussion.source_group_id, current_user.id)
    return group_membership is not None and group_membership.role == "owner"


async def create_or_get_discussion(
    session: AsyncSession,
    payload: DiscussionCreate,
    current_user: User,
) -> Discussion:
    group = await get_group(session, payload.source_group_id)
    if group is None:
        raise LookupError("Group not found")
    await ensure_group_message_access(session, group, current_user)

    source_message = await get_group_message(session, group, payload.source_message_id)
    if source_message is None:
        raise LookupError("Source message not found in this group")

    existing_discussion = await get_discussion_by_source_message(session, source_message.id)
    if existing_discussion is not None:
        return existing_discussion

    discussion = Discussion(
        source_group_id=group.id,
        source_message_id=source_message.id,
        title=payload.title.strip() if payload.title else None,
        created_by_user_id=current_user.id,
    )
    session.add(discussion)
    await session.flush()
    session.add(DiscussionMember(discussion_id=discussion.id, user_id=current_user.id, role="owner"))
    await session.commit()
    return await load_discussion(session, discussion.id)


async def load_discussion(session: AsyncSession, discussion_id: UUID) -> Discussion:
    discussion = await get_discussion(session, discussion_id)
    if discussion is None:
        raise LookupError("Discussion not found")
    return discussion


async def ensure_source_message_visible(session: AsyncSession, source_message_id: UUID, current_user: User) -> Discussion | None:
    discussion = await get_discussion_by_source_message(session, source_message_id)
    if discussion is None:
        return None
    await ensure_group_message_access(session, discussion.source_group, current_user)
    return discussion


async def add_discussion_member(
    session: AsyncSession,
    discussion: Discussion,
    payload: DiscussionMemberCreate,
    current_user: User,
) -> DiscussionMember:
    if not await can_manage_discussion_members(session, discussion, current_user):
        raise PermissionError("Discussion member management access denied")

    username = normalize_discussion_invite_username(payload.username)
    user = await get_user_by_username(session, username)
    if user is None:
        raise LookupError("User not found or is not a member of the source group")
    if not user.is_active:
        raise ValueError("Active user required")
    if user.role == "bot":
        raise ValueError("Bot users cannot join discussions yet")
    if await get_group_membership(session, discussion.source_group_id, user.id) is None:
        raise ValueError("User not found or is not a member of the source group")

    member = DiscussionMember(discussion_id=discussion.id, user_id=user.id, role=payload.role)
    session.add(member)
    await session.commit()
    return await load_discussion_member(session, member.id)


async def load_discussion_member(session: AsyncSession, member_id: UUID) -> DiscussionMember:
    result = await session.execute(
        select(DiscussionMember).options(selectinload(DiscussionMember.user)).where(DiscussionMember.id == member_id)
    )
    return result.scalar_one()


async def get_discussion_member(session: AsyncSession, discussion_id: UUID, member_id: UUID) -> DiscussionMember | None:
    result = await session.execute(
        select(DiscussionMember)
        .options(selectinload(DiscussionMember.user))
        .where(DiscussionMember.id == member_id, DiscussionMember.discussion_id == discussion_id)
    )
    return result.scalar_one_or_none()


async def count_discussion_owners(session: AsyncSession, discussion_id: UUID) -> int:
    result = await session.execute(
        select(func.count(DiscussionMember.id)).where(
            DiscussionMember.discussion_id == discussion_id,
            DiscussionMember.role == "owner",
        )
    )
    return int(result.scalar_one())


async def remove_discussion_member(
    session: AsyncSession,
    discussion: Discussion,
    member: DiscussionMember,
    current_user: User,
) -> None:
    if not await can_manage_discussion_members(session, discussion, current_user):
        raise PermissionError("Discussion member management access denied")
    if member.role == "owner" and await count_discussion_owners(session, discussion.id) <= 1:
        raise ValueError("Cannot remove the last discussion owner")

    await session.delete(member)
    await session.commit()


async def list_discussion_messages(
    session: AsyncSession,
    discussion: Discussion,
    limit: int,
) -> list[DiscussionMessage]:
    result = await session.execute(
        select(DiscussionMessage)
        .options(
            selectinload(DiscussionMessage.sender),
            selectinload(DiscussionMessage.attachments),
            selectinload(DiscussionMessage.reactions).selectinload(DiscussionMessageReaction.user),
        )
        .where(DiscussionMessage.discussion_id == discussion.id)
        .order_by(DiscussionMessage.created_at.desc())
        .limit(limit)
    )
    return list(reversed(result.scalars().all()))


async def create_discussion_message(
    session: AsyncSession,
    discussion: Discussion,
    current_user: User,
    payload: DiscussionMessageCreate,
) -> DiscussionMessage:
    await ensure_discussion_access(session, discussion, current_user)
    message = DiscussionMessage(
        discussion_id=discussion.id,
        sender_user_id=current_user.id,
        body=validate_message_body(payload.body),
    )
    discussion.updated_at = datetime.now(timezone.utc)
    session.add(message)
    await session.commit()
    return await load_discussion_message(session, message.id)


async def create_discussion_message_with_attachments(
    session: AsyncSession,
    discussion: Discussion,
    current_user: User,
    body: str | None,
    uploads: list[UploadFile],
) -> DiscussionMessage:
    await ensure_discussion_access(session, discussion, current_user)
    normalized_body = validate_attachment_message_body(body)
    if not normalized_body and not uploads:
        raise ValueError("Message body or at least one attachment is required")
    saved_uploads = await save_uploads("discussion", discussion.id, uploads) if uploads else []
    try:
        message = DiscussionMessage(
            discussion_id=discussion.id,
            sender_user_id=current_user.id,
            body=normalized_body,
        )
        discussion.updated_at = datetime.now(timezone.utc)
        session.add(message)
        await session.flush()
        session.add_all(
            [DiscussionMessageAttachment(
                discussion_message_id=message.id,
                original_filename=saved_upload.original_filename,
                stored_filename=saved_upload.stored_filename,
                storage_path=saved_upload.storage_path,
                content_type=saved_upload.content_type,
                size_bytes=saved_upload.size_bytes,
                sort_order=sort_order,
            ) for sort_order, saved_upload in enumerate(saved_uploads)]
        )
        await session.commit()
    except BaseException:
        await session.rollback()
        for saved_upload in saved_uploads:
            remove_saved_file(saved_upload.storage_path)
        raise
    return await load_discussion_message(session, message.id)


async def create_discussion_message_with_attachment(
    session: AsyncSession,
    discussion: Discussion,
    current_user: User,
    body: str | None,
    upload: UploadFile,
) -> DiscussionMessage:
    return await create_discussion_message_with_attachments(
        session, discussion, current_user, body, [upload]
    )


async def get_discussion_message(
    session: AsyncSession,
    discussion: Discussion,
    message_id: UUID,
) -> DiscussionMessage | None:
    result = await session.execute(
        select(DiscussionMessage)
        .options(
            selectinload(DiscussionMessage.sender),
            selectinload(DiscussionMessage.attachments),
            selectinload(DiscussionMessage.reactions).selectinload(DiscussionMessageReaction.user),
        )
        .where(DiscussionMessage.id == message_id, DiscussionMessage.discussion_id == discussion.id)
    )
    return result.scalar_one_or_none()


async def load_discussion_message(session: AsyncSession, message_id: UUID) -> DiscussionMessage:
    result = await session.execute(
        select(DiscussionMessage)
        .options(
            selectinload(DiscussionMessage.sender),
            selectinload(DiscussionMessage.attachments),
            selectinload(DiscussionMessage.reactions).selectinload(DiscussionMessageReaction.user),
        )
        .where(DiscussionMessage.id == message_id)
    )
    return result.scalar_one()


async def get_discussion_attachment(
    session: AsyncSession,
    discussion: Discussion,
    attachment_id: UUID,
) -> DiscussionMessageAttachment | None:
    result = await session.execute(
        select(DiscussionMessageAttachment)
        .join(
            DiscussionMessage,
            DiscussionMessage.id == DiscussionMessageAttachment.discussion_message_id,
        )
        .options(selectinload(DiscussionMessageAttachment.discussion_message))
        .where(
            DiscussionMessageAttachment.id == attachment_id,
            DiscussionMessage.discussion_id == discussion.id,
        )
    )
    return result.scalar_one_or_none()


async def update_discussion_message(
    session: AsyncSession,
    discussion: Discussion,
    message: DiscussionMessage,
    current_user: User,
    payload: DiscussionMessageUpdate,
) -> DiscussionMessage:
    await ensure_discussion_access(session, discussion, current_user)
    if message.is_deleted:
        raise ValueError("Deleted messages cannot be edited")
    if message.sender_user_id != current_user.id:
        raise PermissionError("Only sender can edit message")

    message.body = validate_message_body(payload.body)
    message.edited_at = datetime.now(timezone.utc)
    discussion.updated_at = datetime.now(timezone.utc)
    await session.commit()
    return await load_discussion_message(session, message.id)


async def can_delete_discussion_message(
    session: AsyncSession,
    discussion: Discussion,
    message: DiscussionMessage,
    current_user: User,
) -> bool:
    if message.sender_user_id == current_user.id:
        return True
    membership = await get_discussion_membership(session, discussion.id, current_user.id)
    if membership is not None and membership.role == "owner":
        return True
    if is_global_group_admin(current_user):
        try:
            await ensure_group_message_access(session, discussion.source_group, current_user)
        except PermissionError:
            return False
        return True
    return False


async def delete_discussion_message(
    session: AsyncSession,
    discussion: Discussion,
    message: DiscussionMessage,
    current_user: User,
) -> DiscussionMessage:
    if not await can_delete_discussion_message(session, discussion, message, current_user):
        raise PermissionError("Discussion message delete access denied")

    message.is_deleted = True
    message.body = DELETED_MESSAGE_BODY
    discussion.updated_at = datetime.now(timezone.utc)
    await session.commit()
    return await load_discussion_message(session, message.id)


async def list_active_discussion_member_user_ids(session: AsyncSession, discussion_id: UUID) -> list[UUID]:
    result = await session.execute(
        select(DiscussionMember.user_id)
        .join(User, User.id == DiscussionMember.user_id)
        .where(DiscussionMember.discussion_id == discussion_id, User.is_active.is_(True))
    )
    return list(result.scalars().all())
