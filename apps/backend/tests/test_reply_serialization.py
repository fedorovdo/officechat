import unittest
from datetime import datetime, timezone
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch
from uuid import uuid4

from app.api.routes.direct import serialize_conversation
from app.schemas.direct import DirectMessagePublic, DirectMessageReplyPreviewPublic
from app.schemas.discussion import DiscussionMessagePublic
from app.schemas.message import MessagePublic, MessageReplyPreviewPublic


NOW = datetime.now(timezone.utc)


def directory_user(**overrides):
    values = {
        "id": uuid4(),
        "username": "dmitrii",
        "display_name": "Dmitrii",
        "role": "user",
        "is_active": True,
        "avatar_url": None,
    }
    values.update(overrides)
    return SimpleNamespace(**values)


def public_user(**overrides):
    values = vars(directory_user()).copy()
    values.update(
        email=None,
        is_system=False,
        auth_provider="local",
        created_at=NOW,
        updated_at=NOW,
        last_login_at=None,
    )
    values.update(overrides)
    return SimpleNamespace(**values)


def reply_target(*, direct=False, is_archived=False, archived_at=None, is_deleted=False):
    return SimpleNamespace(
        id=uuid4(),
        sender=directory_user() if direct else public_user(),
        body="Original message",
        is_deleted=is_deleted,
        is_archived=is_archived,
        archived_at=archived_at,
        created_at=NOW,
        attachments=[SimpleNamespace(), SimpleNamespace()],
    )


def direct_message(reply_to):
    return SimpleNamespace(
        id=uuid4(),
        conversation_id=uuid4(),
        sender_user_id=uuid4(),
        reply_to_message_id=reply_to.id,
        body="Reply",
        message_type="text",
        is_deleted=False,
        is_archived=False,
        archived_at=None,
        edited_at=None,
        created_at=NOW,
        updated_at=NOW,
        sender=directory_user(),
        reply_to=reply_to,
        attachments=[],
        reactions=[],
    )


class ReplyPreviewSerializationTests(unittest.IsolatedAsyncioTestCase):
    async def test_direct_conversation_last_message_with_reply_serializes(self):
        current_user = directory_user(username="current")
        other_user = directory_user(username="other")
        conversation = SimpleNamespace(
            id=uuid4(),
            user_one_id=current_user.id,
            user_two_id=other_user.id,
            user_one=current_user,
            user_two=other_user,
            created_at=NOW,
            updated_at=NOW,
        )
        message = direct_message(reply_target(direct=True))

        with patch("app.api.routes.direct.get_last_direct_message", AsyncMock(return_value=message)):
            result = await serialize_conversation(AsyncMock(), conversation, current_user)

        self.assertIsNotNone(result.last_message)
        self.assertFalse(result.last_message.reply_to.is_archived)
        self.assertIsNone(result.last_message.reply_to.archived_at)

    async def test_archived_direct_reply_target_serializes(self):
        archived_at = datetime.now(timezone.utc)
        preview = DirectMessageReplyPreviewPublic.model_validate(
            reply_target(direct=True, is_archived=True, archived_at=archived_at)
        )
        self.assertTrue(preview.is_archived)
        self.assertEqual(preview.archived_at, archived_at)

    async def test_deleted_direct_reply_target_keeps_deleted_preview(self):
        preview = DirectMessageReplyPreviewPublic.model_validate(reply_target(direct=True, is_deleted=True))
        self.assertTrue(preview.is_deleted)
        self.assertEqual(preview.body_preview, "Message deleted")

    async def test_historical_reply_dictionary_gets_retention_defaults(self):
        preview = DirectMessageReplyPreviewPublic.model_validate(
            {
                "id": uuid4(),
                "sender": directory_user(),
                "body_preview": "Historical reply",
                "is_deleted": False,
                "created_at": NOW,
                "attachment_count": 0,
            }
        )
        self.assertFalse(preview.is_archived)
        self.assertIsNone(preview.archived_at)

    async def test_group_reply_target_serializes_retention_fields(self):
        target = reply_target()
        message = SimpleNamespace(
            id=uuid4(),
            group_id=uuid4(),
            sender_user_id=uuid4(),
            reply_to_message_id=target.id,
            body="Group reply",
            message_type="text",
            is_deleted=False,
            is_archived=False,
            archived_at=None,
            edited_at=None,
            created_at=NOW,
            updated_at=NOW,
            sender=public_user(),
            reply_to=target,
            attachments=[],
            mentions=[],
            reactions=[],
        )
        serialized = MessagePublic.model_validate(message)
        self.assertIsInstance(serialized.reply_to, MessageReplyPreviewPublic)
        self.assertFalse(serialized.reply_to.is_archived)
        self.assertIsNone(serialized.reply_to.archived_at)

    async def test_discussion_message_retention_fields_serialize(self):
        message = SimpleNamespace(
            id=uuid4(),
            discussion_id=uuid4(),
            sender_user_id=uuid4(),
            body="Discussion message",
            is_deleted=False,
            is_archived=True,
            archived_at=NOW,
            edited_at=None,
            created_at=NOW,
            updated_at=NOW,
            sender=directory_user(),
            attachments=[],
            reactions=[],
        )
        serialized = DiscussionMessagePublic.model_validate(message)
        self.assertTrue(serialized.is_archived)
        self.assertEqual(serialized.archived_at, NOW)


if __name__ == "__main__":
    unittest.main()
