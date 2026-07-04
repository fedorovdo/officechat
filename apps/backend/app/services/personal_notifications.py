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
    await group_websocket_manager.broadcast_to_group(
        group.id,
        group_message_event_payload("message.created", group.id, message),
    )
    event = personal_group_message_event_payload(group, message)
    recipient_ids = await list_active_group_member_user_ids(session, group.id)
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
        await user_websocket_manager.broadcast_to_user(user_id, event)
    await broadcast_unread_for_chat(session, "discussion", discussion.id, recipient_ids, message)
