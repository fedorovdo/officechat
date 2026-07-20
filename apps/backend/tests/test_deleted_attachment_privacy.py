import tempfile
import unittest
from datetime import datetime, timezone
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock, patch
from uuid import uuid4

from fastapi import HTTPException
from starlette.responses import FileResponse

from app.api.routes.direct import download_direct_attachment
from app.api.routes.discussions import download_discussion_attachment
from app.api.routes.groups import download_attachment
from app.core.config import settings
from app.models.attachment import DirectMessageAttachment, DiscussionMessageAttachment, MessageAttachment
from app.models.direct import DirectMessage
from app.models.discussion import DiscussionMessage
from app.models.message import Message
from app.schemas.direct import DirectMessagePublic, DirectMessageReplyPreviewPublic
from app.schemas.discussion import DiscussionMessagePublic
from app.schemas.message import MessagePublic, MessageReplyPreviewPublic
from app.services.deleted_attachment_cleanup import (
    cleanup_deleted_message_attachments,
    deleted_attachment_query,
)
from app.services.direct import delete_direct_message
from app.services.discussions import delete_discussion_message
from app.services.messages import delete_group_message
from app.services.notifications import redact_message_notification_previews
from app.services.pins import message_preview

NOW = datetime.now(timezone.utc)


def directory_user(**overrides):
    values = {
        "id": uuid4(),
        "username": "user",
        "display_name": "User",
        "role": "user",
        "is_active": True,
        "avatar_url": None,
        "last_seen_at": None,
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


def attachment(path: Path, *, kind="group", available=True):
    values = {
        "id": uuid4(),
        "original_filename": "private.txt",
        "stored_filename": path.name,
        "storage_path": str(path),
        "content_type": "text/plain",
        "size_bytes": 7,
        "sort_order": 0,
        "file_available": available,
        "file_deleted_at": None,
        "created_at": NOW,
    }
    if kind == "group":
        values["group_id"] = uuid4()
    return SimpleNamespace(**values)


def message(kind: str, item: object, *, deleted=True):
    sender = public_user() if kind == "group" else directory_user()
    values = {
        "id": uuid4(),
        "sender_user_id": sender.id,
        "body": "secret body",
        "is_deleted": deleted,
        "is_archived": False,
        "archived_at": None,
        "edited_at": None,
        "created_at": NOW,
        "updated_at": NOW,
        "sender": sender,
        "attachments": [item],
        "reactions": [SimpleNamespace(emoji="ok")],
    }
    if kind == "group":
        values.update(
            group_id=uuid4(),
            reply_to_message_id=uuid4(),
            reply_to=SimpleNamespace(),
            message_type="text",
            mentions=[SimpleNamespace()],
        )
    elif kind == "direct":
        values.update(
            conversation_id=uuid4(),
            reply_to_message_id=uuid4(),
            reply_to=SimpleNamespace(),
            message_type="text",
        )
    else:
        values["discussion_id"] = uuid4()
    return SimpleNamespace(**values)


class DeletedAttachmentSerializationTests(unittest.TestCase):
    def test_deleted_messages_hide_attachments_for_all_chat_types(self):
        with tempfile.TemporaryDirectory() as directory:
            item = attachment(Path(directory) / "private.txt")
            cases = (
                (MessagePublic, message("group", item)),
                (DirectMessagePublic, message("direct", item)),
                (DiscussionMessagePublic, message("discussion", item)),
            )
            for schema, source in cases:
                with self.subTest(schema=schema.__name__):
                    serialized = schema.model_validate(source)
                    self.assertEqual(serialized.attachments, [])
                    self.assertEqual(serialized.body, "Message deleted")
                    self.assertEqual(serialized.reactions, [])
                    if hasattr(serialized, "reply_to"):
                        self.assertIsNone(serialized.reply_to)
                        self.assertIsNone(serialized.reply_to_message_id)

    def test_deleted_reply_targets_do_not_expose_attachment_count(self):
        target = SimpleNamespace(
            id=uuid4(),
            sender=public_user(),
            body="secret",
            is_deleted=True,
            is_archived=False,
            archived_at=None,
            created_at=NOW,
            attachments=[SimpleNamespace(), SimpleNamespace()],
        )
        direct_target = SimpleNamespace(**{**vars(target), "sender": directory_user()})
        self.assertEqual(MessageReplyPreviewPublic.model_validate(target).attachment_count, 0)
        self.assertEqual(DirectMessageReplyPreviewPublic.model_validate(direct_target).attachment_count, 0)

    def test_stale_deleted_pin_preview_hides_attachment_count(self):
        source = SimpleNamespace(
            id=uuid4(),
            sender=directory_user(),
            body="Message deleted",
            is_deleted=True,
            is_archived=False,
            archived_at=None,
            created_at=NOW,
            attachments=[SimpleNamespace(), SimpleNamespace()],
        )
        self.assertEqual(message_preview(source).attachment_count, 0)


class DeletedAttachmentDownloadTests(unittest.IsolatedAsyncioTestCase):
    async def test_group_download_is_404_for_author_member_admin_and_superadmin(self):
        group = SimpleNamespace(id=uuid4())
        item = SimpleNamespace(message=SimpleNamespace(is_deleted=True), file_available=True)
        for role in ("user", "admin", "superadmin"):
            for username in ("author", "other"):
                with self.subTest(role=role, username=username), patch(
                    "app.api.routes.groups.load_group_or_404", AsyncMock(return_value=group)
                ), patch(
                    "app.api.routes.groups.ensure_group_message_access", AsyncMock()
                ), patch(
                    "app.api.routes.groups.get_group_attachment", AsyncMock(return_value=item)
                ):
                    with self.assertRaises(HTTPException) as caught:
                        await download_attachment(
                            group.id, uuid4(), AsyncMock(), directory_user(role=role, username=username)
                        )
                    self.assertEqual(caught.exception.status_code, 404)

    async def test_direct_and_discussion_downloads_are_404_for_deleted_parent(self):
        current_user = directory_user()
        conversation = SimpleNamespace(id=uuid4())
        direct_item = SimpleNamespace(
            direct_message=SimpleNamespace(is_deleted=True), file_available=True
        )
        with patch(
            "app.api.routes.direct.load_conversation_or_404", AsyncMock(return_value=conversation)
        ), patch("app.api.routes.direct.ensure_direct_conversation_access", Mock()), patch(
            "app.api.routes.direct.get_direct_attachment", AsyncMock(return_value=direct_item)
        ):
            with self.assertRaises(HTTPException) as caught:
                await download_direct_attachment(
                    conversation.id, uuid4(), AsyncMock(), current_user
                )
            self.assertEqual(caught.exception.status_code, 404)

        discussion = SimpleNamespace(id=uuid4())
        discussion_item = SimpleNamespace(
            discussion_message=SimpleNamespace(is_deleted=True), file_available=True
        )
        with patch(
            "app.api.routes.discussions.load_discussion_or_404", AsyncMock(return_value=discussion)
        ), patch("app.api.routes.discussions.ensure_discussion_access", AsyncMock()), patch(
            "app.api.routes.discussions.get_discussion_attachment",
            AsyncMock(return_value=discussion_item),
        ):
            with self.assertRaises(HTTPException) as caught:
                await download_discussion_attachment(
                    discussion.id, uuid4(), AsyncMock(), current_user
                )
            self.assertEqual(caught.exception.status_code, 404)

    async def test_active_neighbor_attachment_remains_downloadable(self):
        original_uploads_dir = settings.uploads_dir
        try:
            with tempfile.TemporaryDirectory() as directory:
                settings.uploads_dir = directory
                path = Path(directory) / "groups" / "active.txt"
                path.parent.mkdir(parents=True)
                path.write_bytes(b"active")
                group = SimpleNamespace(id=uuid4())
                item = SimpleNamespace(
                    message=SimpleNamespace(is_deleted=False),
                    file_available=True,
                    storage_path=str(path),
                    content_type="text/plain",
                    original_filename="active.txt",
                )
                with patch(
                    "app.api.routes.groups.load_group_or_404", AsyncMock(return_value=group)
                ), patch(
                    "app.api.routes.groups.ensure_group_message_access", AsyncMock()
                ), patch(
                    "app.api.routes.groups.get_group_attachment", AsyncMock(return_value=item)
                ):
                    response = await download_attachment(
                        group.id, uuid4(), AsyncMock(), directory_user()
                    )
                self.assertIsInstance(response, FileResponse)
                self.assertEqual(Path(response.path), path)
        finally:
            settings.uploads_dir = original_uploads_dir


class DeletedAttachmentLifecycleTests(unittest.IsolatedAsyncioTestCase):
    async def test_message_notification_previews_are_redacted_in_current_transaction(self):
        session = AsyncMock()
        message_id = uuid4()

        await redact_message_notification_previews(session, message_id)

        statement = session.execute.await_args.args[0]
        sql = str(statement)
        self.assertIn("UPDATE notifications", sql)
        self.assertIn("notifications.message_id", sql)
        session.commit.assert_not_awaited()

    async def test_all_delete_services_disable_attachments_before_file_cleanup(self):
        original_uploads_dir = settings.uploads_dir
        try:
            with tempfile.TemporaryDirectory() as directory:
                settings.uploads_dir = directory
                for kind in ("group", "direct", "discussion"):
                    path = Path(directory) / kind / "private.txt"
                    path.parent.mkdir(parents=True, exist_ok=True)
                    path.write_bytes(b"private")
                    item = attachment(path, kind=kind)
                    source = message(kind, item, deleted=False)
                    session = AsyncMock()
                    loaded = source

                    if kind == "group":
                        with patch(
                            "app.services.messages.can_delete_message", AsyncMock(return_value=True)
                        ), patch(
                            "app.services.messages.load_message_with_sender",
                            AsyncMock(return_value=loaded),
                        ):
                            await delete_group_message(
                                session, SimpleNamespace(id=source.group_id), source, source.sender
                            )
                    elif kind == "direct":
                        conversation = SimpleNamespace(updated_at=None)
                        with patch(
                            "app.services.direct.ensure_direct_conversation_access", Mock()
                        ), patch(
                            "app.services.direct.load_direct_message", AsyncMock(return_value=loaded)
                        ):
                            await delete_direct_message(session, conversation, source, source.sender)
                    else:
                        discussion = SimpleNamespace(updated_at=None)
                        with patch(
                            "app.services.discussions.can_delete_discussion_message",
                            AsyncMock(return_value=True),
                        ), patch(
                            "app.services.discussions.load_discussion_message",
                            AsyncMock(return_value=loaded),
                        ):
                            await delete_discussion_message(session, discussion, source, source.sender)

                    self.assertTrue(source.is_deleted)
                    self.assertFalse(item.file_available)
                    self.assertIsNotNone(item.file_deleted_at)
                    self.assertFalse(path.exists())
                    session.commit.assert_awaited_once()
        finally:
            settings.uploads_dir = original_uploads_dir

    async def test_unlink_failure_does_not_restore_access(self):
        original_uploads_dir = settings.uploads_dir
        try:
            with tempfile.TemporaryDirectory() as directory:
                settings.uploads_dir = directory
                path = Path(directory) / "groups" / "private.txt"
                path.parent.mkdir(parents=True)
                path.write_bytes(b"private")
                item = attachment(path)
                source = message("group", item, deleted=False)
                session = AsyncMock()
                with patch(
                    "app.services.messages.can_delete_message", AsyncMock(return_value=True)
                ), patch(
                    "app.services.messages.load_message_with_sender", AsyncMock(return_value=source)
                ), patch(
                    "app.services.attachments.remove_saved_file", side_effect=OSError("locked")
                ):
                    await delete_group_message(
                        session, SimpleNamespace(id=source.group_id), source, source.sender
                    )

                self.assertTrue(path.exists())
                self.assertTrue(source.is_deleted)
                self.assertFalse(item.file_available)
                session.commit.assert_awaited_once()
        finally:
            settings.uploads_dir = original_uploads_dir

    async def test_cleanup_dry_run_and_apply_only_touch_deleted_message_files(self):
        original_uploads_dir = settings.uploads_dir
        try:
            with tempfile.TemporaryDirectory() as directory:
                settings.uploads_dir = directory
                orphan_path = Path(directory) / "groups" / "orphan.txt"
                active_path = Path(directory) / "groups" / "active.txt"
                orphan_path.parent.mkdir(parents=True)
                orphan_path.write_bytes(b"orphan")
                active_path.write_bytes(b"active")
                orphan = attachment(orphan_path)
                active = attachment(active_path)
                session = AsyncMock()

                with patch(
                    "app.services.deleted_attachment_cleanup.list_deleted_message_attachments",
                    AsyncMock(return_value=[orphan]),
                ):
                    dry_run = await cleanup_deleted_message_attachments(session)
                    self.assertFalse(dry_run.applied)
                    self.assertEqual(dry_run.records, 1)
                    self.assertEqual(dry_run.files_found, 1)
                    self.assertEqual(dry_run.size_bytes, orphan.size_bytes)
                    self.assertTrue(orphan.file_available)
                    self.assertTrue(orphan_path.exists())
                    session.commit.assert_not_awaited()

                    applied = await cleanup_deleted_message_attachments(session, apply=True)

                self.assertTrue(applied.applied)
                self.assertEqual(applied.files_deleted, 1)
                self.assertFalse(orphan.file_available)
                self.assertFalse(orphan_path.exists())
                self.assertTrue(active.file_available)
                self.assertTrue(active_path.exists())
                session.commit.assert_awaited_once()
        finally:
            settings.uploads_dir = original_uploads_dir

    async def test_cleanup_never_unlinks_before_database_commit(self):
        original_uploads_dir = settings.uploads_dir
        try:
            with tempfile.TemporaryDirectory() as directory:
                settings.uploads_dir = directory
                path = Path(directory) / "groups" / "orphan.txt"
                path.parent.mkdir(parents=True)
                path.write_bytes(b"orphan")
                orphan = attachment(path)
                session = AsyncMock()
                session.commit.side_effect = RuntimeError("commit failed")
                with patch(
                    "app.services.deleted_attachment_cleanup.list_deleted_message_attachments",
                    AsyncMock(return_value=[orphan]),
                ), patch(
                    "app.services.deleted_attachment_cleanup.delete_attachment_files_best_effort"
                ) as delete_files:
                    with self.assertRaisesRegex(RuntimeError, "commit failed"):
                        await cleanup_deleted_message_attachments(session, apply=True)
                delete_files.assert_not_called()
                session.rollback.assert_awaited_once()
                self.assertTrue(path.exists())
        finally:
            settings.uploads_dir = original_uploads_dir

    def test_cleanup_queries_only_deleted_parents(self):
        cases = (
            (MessageAttachment, Message, MessageAttachment.message_id, "messages.is_deleted IS true"),
            (
                DirectMessageAttachment,
                DirectMessage,
                DirectMessageAttachment.direct_message_id,
                "direct_messages.is_deleted IS true",
            ),
            (
                DiscussionMessageAttachment,
                DiscussionMessage,
                DiscussionMessageAttachment.discussion_message_id,
                "discussion_messages.is_deleted IS true",
            ),
        )
        for attachment_model, parent_model, parent_fk, expected in cases:
            with self.subTest(parent=parent_model.__name__):
                sql = str(deleted_attachment_query(attachment_model, parent_model, parent_fk))
                self.assertIn(expected, sql)


if __name__ == "__main__":
    unittest.main()
