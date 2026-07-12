from uuid import UUID

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.direct import DirectConversation, DirectMessage
from app.models.discussion import Discussion, DiscussionMessage
from app.models.group import Group, GroupMember
from app.models.message import Message
from app.models.user import User
from app.schemas.direct import DirectMessagePublic
from app.schemas.discussion import DiscussionMessagePublic
from app.schemas.message import MessagePublic
from app.schemas.user import UserDirectoryEntry
from app.services.websocket_manager import (
    direct_websocket_manager,
    discussion_websocket_manager,
    group_websocket_manager,
    user_websocket_manager,
)
from app.services.unread import broadcast_unread_for_chat
from app.services.notifications import safe_create_notification, sanitize_preview


def group_message_event_payload(event_type: str, group_id: UUID, message: Message) -> dict[str, object]:
    serialized_message = MessagePublic.model_validate(message).model_dump(mode="json")
    event: dict[str, object] = {
        "type": event_type,
        "group_id": str(group_id),
        "message": serialized_message,
    }
    if event_type == "message.deleted":
        event["message_id"] = serialized_message["id"]
    return event


def direct_message_event_payload(
    event_type: str,
    conversation_id: UUID,
    message: DirectMessage,
) -> dict[str, object]:
    serialized_message = DirectMessagePublic.model_validate(message).model_dump(mode="json")
    event: dict[str, object] = {
        "type": event_type,
        "conversation_id": str(conversation_id),
        "message": serialized_message,
    }
    if event_type == "direct.message.deleted":
        event["message_id"] = serialized_message["id"]
    return event


def discussion_message_event_payload(
    event_type: str,
    discussion_id: UUID,
    message: DiscussionMessage,
) -> dict[str, object]:
    serialized_message = DiscussionMessagePublic.model_validate(message).model_dump(mode="json")
    event: dict[str, object] = {
        "type": event_type,
        "discussion_id": str(discussion_id),
        "message": serialized_message,
    }
    if event_type == "discussion.message.deleted":
        event["message_id"] = serialized_message["id"]
    return event


async def list_active_group_member_user_ids(session: AsyncSession, group_id: UUID) -> list[UUID]:
    result = await session.execute(
        select(GroupMember.user_id)
        .join(User, User.id == GroupMember.user_id)
        .where(GroupMember.group_id == group_id, User.is_active.is_(True))
    )
    return list(result.scalars().all())


def personal_group_message_event_payload(group: Group, message: Message) -> dict[str, object]:
    serialized_message = MessagePublic.model_validate(message).model_dump(mode="json")
    return {
        "type": "user.group.message.created",
        "group_id": str(group.id),
        "group": {
            "id": str(group.id),
            "name": group.name,
            "slug": group.slug,
        },
        "message": serialized_message,
        "mentioned_user_ids": [mention["user_id"] for mention in serialized_message["mentions"]],
    }


def get_direct_other_user(conversation: DirectConversation, user_id: UUID) -> User:
    if conversation.user_one_id == user_id:
        return conversation.user_two
    return conversation.user_one


def get_direct_participant(conversation: DirectConversation, user_id: UUID) -> User:
    if conversation.user_one_id == user_id:
        return conversation.user_one
    return conversation.user_two


def personal_direct_message_event_payload(
    conversation: DirectConversation,
    recipient_user_id: UUID,
    message: DirectMessage,
) -> dict[str, object]:
    return {
        "type": "user.direct.message.created",
        "conversation_id": str(conversation.id),
        "other_user": UserDirectoryEntry.model_validate(
            get_direct_other_user(conversation, recipient_user_id)
        ).model_dump(mode="json"),
        "message": DirectMessagePublic.model_validate(message).model_dump(mode="json"),
    }


async def broadcast_group_message_created(session: AsyncSession, group: Group, message: Message) -> None:
    mentioned_user_ids = {mention.mentioned_user_id for mention in message.mentions}
    for user_id in mentioned_user_ids:
        await safe_create_notification(
            session,
            recipient_user_id=user_id,
            notification_type="mention",
            category="messages",
            actor=message.sender,
            source_type="message",
            source_id=message.id,
            chat_type="group",
            chat_id=group.id,
            message_id=message.id,
            title_key="notification.mention",
            body_preview=message.body,
            metadata={"group_id": group.id, "group_name": group.name, "group_slug": group.slug},
        )
    if message.reply_to is not None and message.reply_to.sender_user_id not in mentioned_user_ids:
        await safe_create_notification(
            session,
            recipient_user_id=message.reply_to.sender_user_id,
            notification_type="reply",
            category="messages",
            actor=message.sender,
            source_type="message",
            source_id=message.id,
            chat_type="group",
            chat_id=group.id,
            message_id=message.id,
            title_key="notification.reply",
            body_preview=message.body,
            metadata={"group_id": group.id, "group_name": group.name, "group_slug": group.slug},
        )
    await group_websocket_manager.broadcast_to_group(
        group.id,
        group_message_event_payload("message.created", group.id, message),
    )
    event = personal_group_message_event_payload(group, message)
    recipient_ids = await list_active_group_member_user_ids(session, group.id)
    high_signal_ids = set(mentioned_user_ids)
    if message.reply_to is not None:
        high_signal_ids.add(message.reply_to.sender_user_id)
    for user_id in recipient_ids:
        if user_id in high_signal_ids or user_id == message.sender_user_id:
            continue
        await safe_create_notification(
            session,
            recipient_user_id=user_id,
            notification_type="group_message",
            category="messages",
            actor=message.sender,
            source_type="message",
            source_id=message.id,
            chat_type="group",
            chat_id=group.id,
            message_id=message.id,
            title_key="notification.group_message",
            body_preview=message.body,
            metadata={"group_id": group.id, "group_name": group.name, "group_slug": group.slug},
        )
    for user_id in recipient_ids:
        await user_websocket_manager.broadcast_to_user(user_id, event)
    await broadcast_unread_for_chat(session, "group", group.id, recipient_ids, message)


async def broadcast_direct_message_created(
    session: AsyncSession, conversation: DirectConversation, message: DirectMessage
) -> None:
    await direct_websocket_manager.broadcast_to_conversation(
        conversation.id,
        direct_message_event_payload("direct.message.created", conversation.id, message),
    )

    recipient_user_ids = [
        user_id
        for user_id in (conversation.user_one_id, conversation.user_two_id)
        if get_direct_participant(conversation, user_id).is_active
    ]
    for user_id in recipient_user_ids:
        if user_id == message.sender_user_id:
            continue
        await safe_create_notification(
            session,
            recipient_user_id=user_id,
            notification_type="direct_message",
            category="messages",
            actor=message.sender,
            source_type="direct_message",
            source_id=message.id,
            chat_type="direct",
            chat_id=conversation.id,
            message_id=message.id,
            title_key="notification.direct_message",
            body_preview=message.body,
            metadata={"conversation_id": conversation.id},
        )
    if message.reply_to is not None:
        await safe_create_notification(
            session,
            recipient_user_id=message.reply_to.sender_user_id,
            notification_type="reply",
            category="messages",
            actor=message.sender,
            source_type="direct_message",
            source_id=message.id,
            chat_type="direct",
            chat_id=conversation.id,
            message_id=message.id,
            title_key="notification.reply",
            body_preview=message.body,
            metadata={"conversation_id": conversation.id},
        )
    for user_id in recipient_user_ids:
        recipient = get_direct_participant(conversation, user_id)
        await user_websocket_manager.broadcast_to_user(
            user_id,
            personal_direct_message_event_payload(conversation, user_id, message),
        )
    await broadcast_unread_for_chat(session, "direct", conversation.id, recipient_user_ids, message)


def personal_discussion_message_event_payload(discussion: Discussion, message: DiscussionMessage) -> dict[str, object]:
    return {
        "type": "user.discussion.message.created",
        "discussion_id": str(discussion.id),
        "discussion": {
            "id": str(discussion.id),
            "title": discussion.title,
            "source_group_id": str(discussion.source_group_id),
        },
        "message": DiscussionMessagePublic.model_validate(message).model_dump(mode="json"),
    }


async def broadcast_discussion_message_created(
    session: AsyncSession,
    discussion: Discussion,
    message: DiscussionMessage,
) -> None:
    from app.services.discussions import list_active_discussion_member_user_ids

    await discussion_websocket_manager.broadcast_to_discussion(
        discussion.id,
        discussion_message_event_payload("discussion.message.created", discussion.id, message),
    )
    event = personal_discussion_message_event_payload(discussion, message)
    recipient_ids = await list_active_discussion_member_user_ids(session, discussion.id)
    for user_id in recipient_ids:
        if user_id == message.sender_user_id:
            continue
        await safe_create_notification(
            session,
            recipient_user_id=user_id,
            notification_type="discussion_message",
            category="messages",
            actor=message.sender,
            source_type="discussion_message",
            source_id=message.id,
            chat_type="discussion",
            chat_id=discussion.id,
            message_id=message.id,
            title_key="notification.discussion_message",
            body_preview=message.body,
            metadata={"discussion_id": discussion.id, "source_group_id": discussion.source_group_id},
        )
    for user_id in recipient_ids:
        await user_websocket_manager.broadcast_to_user(user_id, event)
    await broadcast_unread_for_chat(session, "discussion", discussion.id, recipient_ids, message)
