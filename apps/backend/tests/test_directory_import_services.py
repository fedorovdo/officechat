import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch
from uuid import uuid4

from app.schemas.directory_import import (
    DirectoryImportBatchUpdate,
    DirectoryImportNormalizedData,
    DirectoryImportRowUpdate,
)
from pydantic import ValidationError
from app.services import directory_imports
from app.services.directory_import_parser import ImportLimits, parse_directory_file


FIXTURES = Path(__file__).parent / "fixtures"


class Session:
    def __init__(self, row):
        self.row = row
        self.executed = []

    async def scalar(self, _statement):
        return self.row

    async def execute(self, statement):
        self.executed.append(statement)
        return None

    async def flush(self):
        return None

    async def refresh(self, _instance):
        return None


class DirectoryImportServiceTests(unittest.IsolatedAsyncioTestCase):
    def test_patch_schemas_reject_invalid_email_extra_fields_and_oversized_mapping(self):
        with self.assertRaises(ValidationError):
            DirectoryImportNormalizedData(email="not-an-email")
        with self.assertRaises(ValidationError):
            DirectoryImportRowUpdate.model_validate({"source_row_start": 99})
        with self.assertRaises(ValidationError):
            DirectoryImportBatchUpdate(
                column_mapping={str(index): "display_name" for index in range(1001)}
            )

    async def test_patch_row_can_fix_blocking_display_name_and_select_row(self):
        batch = SimpleNamespace(id=uuid4(), status="analyzed")
        row = SimpleNamespace(
            id=uuid4(),
            batch_id=batch.id,
            detected_kind="unknown",
            normalized_data={"display_name": None},
            warnings=[{"code": "missing_display_name", "severity": "blocking"}],
            proposed_action="skip",
            is_selected=False,
        )
        payload = DirectoryImportRowUpdate(
            detected_kind="person",
            normalized_data=DirectoryImportNormalizedData(display_name="Test User"),
            proposed_action="create",
            is_selected=True,
        )

        with patch.object(
            directory_imports,
            "refresh_batch_counts",
            new=AsyncMock(),
        ):
            updated = await directory_imports.update_import_row(
                Session(row),
                batch,
                row.id,
                payload,
            )

        self.assertEqual(updated.detected_kind, "person")
        self.assertEqual(updated.normalized_data["display_name"], "Test User")
        self.assertTrue(updated.is_selected)
        self.assertFalse(
            any(item["code"] == "missing_display_name" for item in updated.warnings)
        )

    async def test_patch_row_keeps_empty_display_name_blocking(self):
        batch = SimpleNamespace(id=uuid4(), status="analyzed")
        row = SimpleNamespace(
            id=uuid4(),
            batch_id=batch.id,
            detected_kind="unknown",
            normalized_data={"display_name": None},
            warnings=[],
            proposed_action="skip",
            is_selected=False,
        )
        payload = DirectoryImportRowUpdate(
            normalized_data=DirectoryImportNormalizedData(display_name=" "),
        )

        with patch.object(
            directory_imports,
            "refresh_batch_counts",
            new=AsyncMock(),
        ):
            updated = await directory_imports.update_import_row(
                Session(row),
                batch,
                row.id,
                payload,
            )

        self.assertTrue(
            any(
                item["code"] == "missing_display_name"
                and item["severity"] == "blocking"
                for item in updated.warnings
            )
        )

    async def test_cancel_removes_preview_rows_and_clears_counts(self):
        batch = SimpleNamespace(
            id=uuid4(),
            status="analyzed",
            detected_rows=3,
            selected_rows=2,
            warning_rows=1,
        )
        session = Session(None)

        cancelled = await directory_imports.cancel_import_batch(session, batch)

        self.assertEqual(cancelled.status, "cancelled")
        self.assertEqual(cancelled.detected_rows, 0)
        self.assertEqual(cancelled.selected_rows, 0)
        self.assertEqual(cancelled.warning_rows, 0)
        self.assertEqual(len(session.executed), 1)

    def test_reanalysis_snapshot_preserves_legacy_ranges_and_warnings(self):
        parsed = parse_directory_file(
            FIXTURES / "directory_import_legacy.csv",
            original_filename="synthetic-directory.csv",
            parser_mode="legacy_layout",
            selected_sheet=None,
            column_mapping=None,
            limits=ImportLimits(
                max_file_size_bytes=10 * 1024 * 1024,
                max_sheets=20,
                max_rows=20000,
                max_columns=100,
                max_cells=200000,
                max_cell_length=2000,
                max_zip_members=1000,
                max_uncompressed_bytes=100 * 1024 * 1024,
            ),
        )
        stored_rows = [
            SimpleNamespace(
                source_sheet=candidate.source_sheet,
                raw_cells=candidate.raw_cells,
            )
            for candidate in parsed.candidates
        ]
        reconstructed = directory_imports._reconstruct_source_rows(stored_rows)
        replayed = directory_imports.parse_legacy_layout(reconstructed["CSV"])

        summary = lambda candidates: [
            (
                candidate.source_row_start,
                candidate.source_row_end,
                candidate.detected_kind,
                candidate.normalized_data,
                candidate.warnings,
            )
            for candidate in candidates
        ]
        self.assertEqual(summary(replayed), summary(parsed.candidates))
