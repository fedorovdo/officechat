import asyncio
import os
import unittest
from datetime import datetime, timezone
from uuid import uuid4

from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app.core.config import settings
from app.db.database_url import normalize_async_postgresql_url
from app.models.audit import AuditEvent
from app.models.directory import DirectoryEntry
from app.models.directory_import import DirectoryImportBatch, DirectoryImportRow
from app.models.user import User
from app.schemas.directory import DirectoryEntryPermanentDelete
from app.services.directory import (
    DirectoryPermanentDeleteError,
    permanently_delete_directory_entry,
)


@unittest.skipUnless(
    os.getenv("RUN_POSTGRES_INTEGRATION_TESTS") == "1",
    "set RUN_POSTGRES_INTEGRATION_TESTS=1 to run PostgreSQL integration tests",
)
class DirectoryDeletePostgresTests(unittest.IsolatedAsyncioTestCase):
    async def test_delete_keeps_import_history_and_nulls_entry_references(self):
        engine = create_async_engine(
            normalize_async_postgresql_url(settings.database_url),
            pool_pre_ping=True,
        )
        session_factory = async_sessionmaker(engine, expire_on_commit=False)
        actor_id = batch_id = entry_id = None
        try:
            async with session_factory() as session:
                actor = User(
                    username=f"directory-delete-{uuid4().hex[:10]}",
                    display_name="Directory Delete Actor",
                    role="superadmin",
                    is_active=True,
                    is_system=False,
                    auth_provider="local",
                )
                entry = DirectoryEntry(
                    display_name="Synthetic Archived Contact",
                    is_active=False,
                    created_by_user_id=actor.id,
                    updated_by_user_id=actor.id,
                )
                session.add_all([actor, entry])
                await session.flush()
                actor_id = actor.id
                entry_id = entry.id
                batch = DirectoryImportBatch(
                    original_filename="synthetic.csv",
                    file_type="csv",
                    file_sha256="d" * 64,
                    available_sheets=["CSV"],
                    selected_sheet="CSV",
                    parser_mode="table",
                    column_mapping={"0": "display_name"},
                    source_columns=[],
                    status="completed",
                    total_source_rows=1,
                    detected_rows=1,
                    selected_rows=1,
                    warning_rows=0,
                    execution_summary={"created": 0, "updated": 1, "result_entry_ids": [str(entry.id)]},
                    created_by_user_id=actor.id,
                )
                session.add(batch)
                await session.flush()
                batch_id = batch.id
                row = DirectoryImportRow(
                    batch_id=batch.id,
                    source_sheet="CSV",
                    source_row_start=2,
                    source_row_end=2,
                    raw_cells={"rows": []},
                    detected_kind="person",
                    confidence=1.0,
                    normalized_data={"display_name": entry.display_name},
                    warnings=[],
                    is_selected=True,
                    proposed_action="update",
                    match_status="exact",
                    matched_entry_id=entry.id,
                    update_fields=["display_name"],
                    restore_if_archived=False,
                    execution_status="updated",
                    result_entry_id=entry.id,
                    sort_order=0,
                )
                session.add(row)
                await session.commit()
                expected_updated_at = entry.updated_at

            async with session_factory() as session:
                actor = await session.get(User, actor_id)
                await permanently_delete_directory_entry(
                    session,
                    entry_id,
                    DirectoryEntryPermanentDelete(
                        confirmation_name=" Synthetic Archived Contact ",
                        reason="test_data",
                        expected_updated_at=expected_updated_at,
                    ),
                    actor,
                    None,
                )
                await session.commit()

            async with session_factory() as session:
                self.assertIsNone(await session.get(DirectoryEntry, entry_id))
                stored_batch = await session.get(DirectoryImportBatch, batch_id)
                self.assertIsNotNone(stored_batch)
                self.assertEqual(stored_batch.execution_summary["updated"], 1)
                stored_row = await session.scalar(
                    select(DirectoryImportRow).where(DirectoryImportRow.batch_id == batch_id)
                )
                self.assertIsNone(stored_row.matched_entry_id)
                self.assertIsNone(stored_row.result_entry_id)
                audit = await session.scalar(
                    select(AuditEvent).where(
                        AuditEvent.actor_user_id == actor_id,
                        AuditEvent.event_type == "directory_entry_deleted_permanently",
                    )
                )
                self.assertEqual(audit.target_id, str(entry_id))
                self.assertIsNone(audit.target_label)
                self.assertNotIn("display_name", audit.details)
                self.assertNotIn("confirmation_name", audit.details)
        finally:
            async with session_factory() as session:
                if batch_id is not None:
                    await session.execute(
                        delete(DirectoryImportBatch).where(DirectoryImportBatch.id == batch_id)
                    )
                if actor_id is not None:
                    await session.execute(
                        delete(AuditEvent).where(AuditEvent.actor_user_id == actor_id)
                    )
                if entry_id is not None:
                    await session.execute(
                        delete(DirectoryEntry).where(DirectoryEntry.id == entry_id)
                    )
                if actor_id is not None:
                    await session.execute(delete(User).where(User.id == actor_id))
                await session.commit()
            await engine.dispose()

    async def test_concurrent_delete_has_one_success_and_one_not_found(self):
        engine = create_async_engine(
            normalize_async_postgresql_url(settings.database_url),
            pool_pre_ping=True,
        )
        session_factory = async_sessionmaker(engine, expire_on_commit=False)
        actor_id = entry_id = None
        try:
            async with session_factory() as session:
                actor = User(
                    username=f"directory-race-{uuid4().hex[:10]}",
                    display_name="Directory Race Actor",
                    role="superadmin",
                    is_active=True,
                    is_system=False,
                    auth_provider="local",
                )
                session.add(actor)
                await session.flush()
                entry = DirectoryEntry(
                    display_name="Concurrent Delete Contact",
                    is_active=False,
                    created_by_user_id=actor.id,
                    updated_by_user_id=actor.id,
                )
                session.add(entry)
                await session.commit()
                actor_id = actor.id
                entry_id = entry.id
                expected_updated_at = entry.updated_at

            async def delete_once() -> str:
                async with session_factory() as session:
                    actor = await session.get(User, actor_id)
                    try:
                        await permanently_delete_directory_entry(
                            session,
                            entry_id,
                            DirectoryEntryPermanentDelete(
                                confirmation_name="Concurrent Delete Contact",
                                reason="duplicate",
                                expected_updated_at=expected_updated_at,
                            ),
                            actor,
                            None,
                        )
                        await session.commit()
                        return "deleted"
                    except DirectoryPermanentDeleteError as exc:
                        await session.rollback()
                        return exc.code

            results = await asyncio.gather(delete_once(), delete_once())
            self.assertCountEqual(results, ["deleted", "directory_entry_not_found"])

            async with session_factory() as session:
                audits = (
                    await session.execute(
                        select(AuditEvent).where(
                            AuditEvent.actor_user_id == actor_id,
                            AuditEvent.event_type == "directory_entry_deleted_permanently",
                        )
                    )
                ).scalars().all()
                self.assertEqual(len(audits), 1)
        finally:
            async with session_factory() as session:
                if actor_id is not None:
                    await session.execute(
                        delete(AuditEvent).where(AuditEvent.actor_user_id == actor_id)
                    )
                if entry_id is not None:
                    await session.execute(
                        delete(DirectoryEntry).where(DirectoryEntry.id == entry_id)
                    )
                if actor_id is not None:
                    await session.execute(delete(User).where(User.id == actor_id))
                await session.commit()
            await engine.dispose()
