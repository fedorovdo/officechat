import os
import unittest

from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app.core.config import settings
from app.db.database_url import normalize_async_postgresql_url
from app.models.directory_import import DirectoryImportBatch, DirectoryImportRow


@unittest.skipUnless(
    os.getenv("RUN_POSTGRES_INTEGRATION_TESTS") == "1",
    "set RUN_POSTGRES_INTEGRATION_TESTS=1 to run PostgreSQL JSONB integration tests",
)
class DirectoryImportPostgresTests(unittest.IsolatedAsyncioTestCase):
    async def test_preview_jsonb_round_trip(self):
        engine = create_async_engine(
            normalize_async_postgresql_url(settings.database_url),
            pool_pre_ping=True,
        )
        session_factory = async_sessionmaker(engine, expire_on_commit=False)
        batch_id = None
        try:
            async with session_factory() as session:
                batch = DirectoryImportBatch(
                    original_filename="synthetic.csv",
                    file_type="csv",
                    file_sha256="c" * 64,
                    available_sheets=["CSV"],
                    selected_sheet="CSV",
                    parser_mode="table",
                    column_mapping={"0": "display_name"},
                    source_columns=[
                        {"index": 0, "label": "Name", "samples": ["Test User"]}
                    ],
                    status="analyzed",
                    total_source_rows=2,
                    detected_rows=1,
                    selected_rows=1,
                    warning_rows=1,
                )
                session.add(batch)
                await session.flush()
                batch_id = batch.id
                session.add(
                    DirectoryImportRow(
                        batch_id=batch.id,
                        source_sheet="CSV",
                        source_row_start=2,
                        source_row_end=2,
                        raw_cells={"rows": [{"row": 2, "cells": ["Test User"]}]},
                        detected_kind="person",
                        confidence=0.9,
                        normalized_data={"display_name": "Test User"},
                        warnings=[{"code": "synthetic_warning", "severity": "warning"}],
                        is_selected=True,
                        proposed_action="create",
                        sort_order=0,
                    )
                )
                await session.commit()

            async with session_factory() as session:
                stored = await session.scalar(
                    select(DirectoryImportRow).where(
                        DirectoryImportRow.batch_id == batch_id
                    )
                )
                self.assertIsNotNone(stored)
                self.assertEqual(stored.raw_cells["rows"][0]["cells"], ["Test User"])
                self.assertEqual(stored.normalized_data["display_name"], "Test User")
                self.assertEqual(stored.warnings[0]["severity"], "warning")

            async with session_factory() as session:
                await session.execute(
                    delete(DirectoryImportBatch).where(
                        DirectoryImportBatch.id == batch_id
                    )
                )
                await session.commit()
            async with session_factory() as session:
                stored = await session.scalar(
                    select(DirectoryImportRow).where(
                        DirectoryImportRow.batch_id == batch_id
                    )
                )
                self.assertIsNone(stored)
            batch_id = None
        finally:
            if batch_id is not None:
                async with session_factory() as session:
                    await session.execute(
                        delete(DirectoryImportBatch).where(
                            DirectoryImportBatch.id == batch_id
                        )
                    )
                    await session.commit()
            await engine.dispose()
