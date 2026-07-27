import io
import tempfile
import unittest
from datetime import UTC, datetime
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch
from uuid import uuid4

from fastapi import UploadFile

from app.api.routes import api_router
from app.api.routes import directory_imports as routes
from app.services.directory_import_parser import DirectoryImportFormatError


class Session:
    def __init__(self):
        self.commits = 0
        self.rollbacks = 0
        self.deleted = []

    async def commit(self):
        self.commits += 1

    async def rollback(self):
        self.rollbacks += 1

    async def delete(self, instance):
        self.deleted.append(instance)


class DirectoryImportApiTests(unittest.IsolatedAsyncioTestCase):
    def test_every_import_endpoint_requires_directory_management_permission(self):
        import_routes = [
            route
            for route in api_router.routes
            if getattr(route, "path", "").startswith("/directory/imports")
        ]
        self.assertGreaterEqual(len(import_routes), 7)
        for route in import_routes:
            dependency_names = {
                getattr(dependency.call, "__name__", "")
                for dependency in route.dependant.dependencies
            }
            self.assertIn("require_can_manage_directory", dependency_names, route.path)

    async def test_temporary_upload_is_removed_after_parser_failure(self):
        upload = UploadFile(filename="directory.csv", file=io.BytesIO(b"Name,Phone\nTest,12345"))
        session = Session()
        request = SimpleNamespace(client=None, headers={}, state=SimpleNamespace(request_id="req-1"))
        actor = SimpleNamespace(id="00000000-0000-0000-0000-000000000001")
        seen_path: Path | None = None

        def fail_parser(path, **_kwargs):
            nonlocal seen_path
            seen_path = Path(path)
            self.assertTrue(seen_path.exists())
            raise DirectoryImportFormatError("synthetic parser failure")

        with patch.object(routes, "parse_directory_file", side_effect=fail_parser):
            with self.assertRaises(Exception):
                await routes.upload_directory_import(
                    request=request,
                    file=upload,
                    session=session,
                    current_user=actor,
                    parser_mode="auto",
                    selected_sheet=None,
                    column_mapping=None,
                )

        self.assertIsNotNone(seen_path)
        self.assertFalse(seen_path.exists())
        self.assertEqual(session.rollbacks, 1)

    async def test_successful_upload_removes_temporary_file_and_uses_safe_audit(self):
        upload = UploadFile(
            filename="directory.csv",
            file=io.BytesIO(b"Name,Phone\nTest,12345"),
        )
        session = Session()
        request = SimpleNamespace(
            client=None,
            headers={},
            state=SimpleNamespace(request_id="req-2"),
        )
        actor = SimpleNamespace(id=uuid4())
        now = datetime.now(UTC)
        batch = SimpleNamespace(
            id=uuid4(),
            original_filename="directory.csv",
            file_type="csv",
            file_sha256="a" * 64,
            available_sheets=["CSV"],
            selected_sheet="CSV",
            parser_mode="auto",
            column_mapping={"0": "display_name"},
            source_columns=[],
            status="analyzed",
            total_source_rows=2,
            detected_rows=1,
            selected_rows=1,
            warning_rows=0,
            created_by_user_id=actor.id,
            created_at=now,
            updated_at=now,
        )
        seen_path: Path | None = None

        def parse_ok(path, **_kwargs):
            nonlocal seen_path
            seen_path = Path(path)
            self.assertTrue(seen_path.exists())
            return object()

        with (
            patch.object(routes, "parse_directory_file", side_effect=parse_ok),
            patch.object(
                routes,
                "create_import_batch",
                new=AsyncMock(return_value=batch),
            ),
            patch.object(routes, "record_audit_event", new=AsyncMock()) as audit,
        ):
            response = await routes.upload_directory_import(
                request=request,
                file=upload,
                session=session,
                current_user=actor,
                parser_mode="auto",
                selected_sheet=None,
                column_mapping=None,
            )

        self.assertEqual(response.id, batch.id)
        self.assertEqual(session.commits, 1)
        self.assertIsNotNone(seen_path)
        self.assertFalse(seen_path.exists())
        for call in audit.await_args_list:
            serialized = repr(call.kwargs["details"]).lower()
            self.assertNotIn("raw_cells", serialized)
            self.assertNotIn("phone", serialized)
            self.assertNotIn("email", serialized)
            self.assertNotIn("notes", serialized)

    def test_safe_audit_details_exclude_contact_and_raw_data(self):
        batch = SimpleNamespace(
            id=uuid4(),
            original_filename="safe.csv",
            file_sha256="b" * 64,
            parser_mode="legacy_layout",
            total_source_rows=10,
            detected_rows=5,
            selected_rows=4,
            warning_rows=2,
            raw_cells={"phone": "3 11 11"},
            normalized_data={"email": "hidden@example.invalid"},
        )
        details = routes.safe_import_audit_details(batch, include_counts=True)

        self.assertEqual(
            set(details),
            {
                "batch_id",
                "filename",
                "hash_prefix",
                "parser_mode",
                "total_source_rows",
                "detected_rows",
                "selected_rows",
                "warning_rows",
            },
        )

    async def test_delete_removes_batch_after_safe_audit_snapshot(self):
        session = Session()
        request = SimpleNamespace(
            client=None,
            headers={},
            state=SimpleNamespace(request_id="req-delete"),
        )
        actor = SimpleNamespace(id=uuid4())
        now = datetime.now(UTC)
        batch = SimpleNamespace(
            id=uuid4(),
            original_filename="directory.csv",
            file_type="csv",
            file_sha256="d" * 64,
            available_sheets=["CSV"],
            selected_sheet="CSV",
            parser_mode="auto",
            column_mapping={},
            source_columns=[],
            status="analyzed",
            total_source_rows=2,
            detected_rows=1,
            selected_rows=1,
            warning_rows=0,
            created_by_user_id=actor.id,
            created_at=now,
            updated_at=now,
        )

        async def cancel(_session, value):
            value.status = "cancelled"
            value.detected_rows = 0
            value.selected_rows = 0
            value.warning_rows = 0
            return value

        with (
            patch.object(routes, "get_import_batch", new=AsyncMock(return_value=batch)),
            patch.object(routes, "cancel_import_batch", side_effect=cancel),
            patch.object(routes, "record_audit_event", new=AsyncMock()) as audit,
        ):
            response = await routes.delete_directory_import(
                batch_id=batch.id,
                request=request,
                session=session,
                current_user=actor,
            )

        self.assertEqual(response.status, "cancelled")
        self.assertEqual(session.deleted, [batch])
        self.assertEqual(session.commits, 1)
        serialized = repr(audit.await_args.kwargs["details"]).lower()
        self.assertNotIn("raw_cells", serialized)
        self.assertNotIn("normalized_data", serialized)


if __name__ == "__main__":
    unittest.main()
