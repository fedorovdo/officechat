import tempfile
import unittest
from datetime import datetime, timezone
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock
from uuid import uuid4

from app.core.config import settings as app_settings
from app.models.attachment import MessageAttachment
from app.models.message import Message
from app.models.retention import RetentionSettings
from app.schemas.retention import RetentionSettingsUpdate
from app.services.retention import (
    archive_model_batches,
    calculate_retention_summary,
    cleanup_attachment_model_batches,
    retention_cleanup_lock,
    run_retention_cleanup,
)


class ScalarRows:
    def __init__(self, rows):
        self.rows = rows

    def scalars(self):
        return self

    def all(self):
        return self.rows


class ScalarCount:
    def __init__(self, value):
        self.value = value

    def scalar_one(self):
        return self.value


class BatchSession:
    def __init__(self, batches):
        self.batches = list(batches)
        self.commits = 0
        self.rollbacks = 0

    async def execute(self, _statement):
        return ScalarRows(self.batches.pop(0) if self.batches else [])

    async def commit(self):
        self.commits += 1

    async def rollback(self):
        self.rollbacks += 1


class RetentionValidationTests(unittest.TestCase):
    def test_retention_defaults_are_non_destructive(self):
        current = RetentionSettings(
            retention_enabled=False,
            active_history_days=0,
            archive_enabled=True,
            cleanup_batch_size=500,
            cleanup_interval_hours=24,
        )
        self.assertFalse(current.retention_enabled)
        self.assertEqual(current.active_history_days, 0)
        self.assertIsNone(current.attachment_retention_days)

    def test_settings_reject_negative_days_and_invalid_batch(self):
        with self.assertRaises(ValueError):
            RetentionSettingsUpdate(active_history_days=-1)
        with self.assertRaises(ValueError):
            RetentionSettingsUpdate(cleanup_batch_size=0)
        with self.assertRaises(ValueError):
            RetentionSettingsUpdate(retention_enabled=None)


class RetentionServiceTests(unittest.IsolatedAsyncioTestCase):
    async def test_archives_in_bounded_batches(self):
        rows = [SimpleNamespace(is_archived=False, archived_at=None) for _ in range(3)]
        session = BatchSession([rows[:2], rows[2:], []])
        count = await archive_model_batches(session, Message, datetime.now(timezone.utc), 2)
        self.assertEqual(count, 3)
        self.assertEqual(session.commits, 2)
        self.assertTrue(all(row.is_archived for row in rows))

    async def test_dry_run_calculation_does_not_touch_files(self):
        session = AsyncMock()
        session.execute.side_effect = [ScalarCount(value) for value in (2, 3, 4)]
        current = RetentionSettings(
            retention_enabled=False,
            active_history_days=30,
            archive_enabled=True,
            attachment_retention_days=None,
            cleanup_batch_size=500,
            cleanup_interval_hours=24,
        )
        with tempfile.TemporaryDirectory() as directory:
            marker = Path(directory) / "keep.txt"
            marker.write_bytes(b"keep")
            summary = await calculate_retention_summary(session, current)
            self.assertEqual(summary.group_messages_archived, 2)
            self.assertEqual(summary.direct_messages_archived, 3)
            self.assertEqual(summary.discussion_messages_archived, 4)
            self.assertEqual(summary.attachments_deleted, 0)
            self.assertEqual(marker.read_bytes(), b"keep")

    async def test_attachment_cleanup_removes_file_but_keeps_metadata(self):
        original_root = app_settings.uploads_dir
        try:
            with tempfile.TemporaryDirectory() as directory:
                app_settings.uploads_dir = directory
                path = Path(directory) / "groups" / "test.txt"
                path.parent.mkdir(parents=True)
                path.write_bytes(b"retention")
                attachment = MessageAttachment(
                    id=uuid4(),
                    message_id=uuid4(),
                    group_id=uuid4(),
                    uploaded_by_user_id=uuid4(),
                    original_filename="test.txt",
                    stored_filename="safe.txt",
                    storage_path=str(path),
                    content_type="text/plain",
                    size_bytes=9,
                    sort_order=0,
                    file_available=True,
                )
                session = BatchSession([[attachment], []])
                deleted, missing = await cleanup_attachment_model_batches(
                    session, MessageAttachment, datetime.now(timezone.utc), 10
                )
                self.assertEqual((deleted, missing), (1, 0))
                self.assertFalse(path.exists())
                self.assertFalse(attachment.file_available)
                self.assertIsNotNone(attachment.file_deleted_at)
                self.assertEqual(attachment.original_filename, "test.txt")
        finally:
            app_settings.uploads_dir = original_root

    async def test_concurrent_cleanup_is_rejected(self):
        await retention_cleanup_lock.acquire()
        try:
            current = RetentionSettings(retention_enabled=True, last_cleanup_status=None)
            with self.assertRaisesRegex(RuntimeError, "already running"):
                await run_retention_cleanup(AsyncMock(), current, SimpleNamespace(id=uuid4()))
        finally:
            retention_cleanup_lock.release()


if __name__ == "__main__":
    unittest.main()
