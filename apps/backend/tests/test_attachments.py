import tempfile
import unittest
from io import BytesIO
from pathlib import Path
from uuid import uuid4

from fastapi import UploadFile
from starlette.datastructures import Headers

from app.core.config import settings
from app.services.attachments import save_uploads


def upload(filename: str, content: bytes, content_type: str = "application/octet-stream") -> UploadFile:
    return UploadFile(
        file=BytesIO(content),
        filename=filename,
        headers=Headers({"content-type": content_type}),
    )


class AttachmentBatchStorageTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self) -> None:
        self.temp_dir = tempfile.TemporaryDirectory()
        self.original_uploads_dir = settings.uploads_dir
        self.original_max_files = settings.attachment_max_files_per_message
        self.original_total_size = settings.attachment_max_total_size_mb
        settings.uploads_dir = self.temp_dir.name
        settings.attachment_max_files_per_message = 10
        settings.attachment_max_total_size_mb = 50

    async def asyncTearDown(self) -> None:
        settings.uploads_dir = self.original_uploads_dir
        settings.attachment_max_files_per_message = self.original_max_files
        settings.attachment_max_total_size_mb = self.original_total_size
        self.temp_dir.cleanup()

    def stored_files(self) -> list[Path]:
        return [path for path in Path(self.temp_dir.name).rglob("*") if path.is_file()]

    async def test_saves_txt_and_duplicate_names_in_upload_order(self) -> None:
        saved = await save_uploads(
            "direct",
            uuid4(),
            [upload("report.txt", b"first"), upload("report.txt", b"second")],
        )

        self.assertEqual([item.original_filename for item in saved], ["report.txt", "report.txt"])
        self.assertNotEqual(saved[0].stored_filename, saved[1].stored_filename)
        self.assertEqual([Path(item.storage_path).read_bytes() for item in saved], [b"first", b"second"])

    async def test_rejects_too_many_files_before_writing(self) -> None:
        with self.assertRaisesRegex(ValueError, "at most 10"):
            await save_uploads("group", uuid4(), [upload(f"{index}.txt", b"x") for index in range(11)])
        self.assertEqual(self.stored_files(), [])

    async def test_blocked_file_rejects_entire_batch_before_writing(self) -> None:
        with self.assertRaisesRegex(ValueError, "File type is not allowed"):
            await save_uploads("discussion", uuid4(), [upload("valid.txt", b"ok"), upload("blocked.exe", b"no")])
        self.assertEqual(self.stored_files(), [])

    async def test_total_size_failure_removes_all_request_files(self) -> None:
        settings.attachment_max_total_size_mb = 0
        with self.assertRaisesRegex(ValueError, "Total attachment size"):
            await save_uploads("group", uuid4(), [upload("first.txt", b"one"), upload("second.txt", b"two")])
        self.assertEqual(self.stored_files(), [])


if __name__ == "__main__":
    unittest.main()
