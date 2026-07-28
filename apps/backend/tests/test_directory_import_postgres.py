import asyncio
import os
import unittest
from unittest.mock import patch
from uuid import uuid4

from sqlalchemy import delete, func, select
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app.core.config import settings
from app.db.database_url import normalize_async_postgresql_url
from app.models.directory_import import DirectoryImportBatch, DirectoryImportRow
from app.models.directory import DirectoryEntry
from app.models.audit import AuditEvent
from app.models.user import User
from app.schemas.directory_import import DirectoryImportBatchPublic, DirectoryImportMatchUpdate
from app.services import directory_import_reconciliation as reconciliation


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
        batch_id = actor_id = None
        try:
            async with session_factory() as session:
                actor = User(
                    username=f"stage1-preview-{uuid4().hex[:10]}",
                    display_name="Stage 1 Preview",
                    role="superadmin",
                    is_active=True,
                    is_system=False,
                    auth_provider="local",
                )
                session.add(actor)
                await session.flush()
                actor_id = actor.id
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
                    created_by_user_id=actor.id,
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
                stored_batch = await session.get(DirectoryImportBatch, batch_id)
                self.assertEqual(stored_batch.version, 1)
                self.assertIsNone(stored_batch.execution_summary)
                actor = await session.get(User, actor_id)
                reconciled = await reconciliation.reconcile_directory_import_batch(
                    session,
                    batch_id,
                    actor=actor,
                )
                self.assertEqual(reconciled.status, "reconciled")
                await session.commit()

            async with session_factory() as session:
                await session.execute(
                    delete(DirectoryImportBatch).where(
                        DirectoryImportBatch.id == batch_id
                    )
                )
                await session.commit()
            async with session_factory() as session:
                await session.execute(delete(User).where(User.id == actor_id))
                await session.commit()
            async with session_factory() as session:
                stored = await session.scalar(
                    select(DirectoryImportRow).where(
                        DirectoryImportRow.batch_id == batch_id
                    )
                )
                self.assertIsNone(stored)
            batch_id = None
            actor_id = None
        finally:
            if batch_id is not None:
                async with session_factory() as session:
                    await session.execute(
                        delete(DirectoryImportBatch).where(
                            DirectoryImportBatch.id == batch_id
                        )
                    )
                    await session.commit()
            if actor_id is not None:
                async with session_factory() as session:
                    await session.execute(delete(User).where(User.id == actor_id))
                    await session.commit()
            await engine.dispose()

    async def test_atomic_reconciliation_execute_and_idempotent_retry(self):
        engine = create_async_engine(
            normalize_async_postgresql_url(settings.database_url),
            pool_pre_ping=True,
        )
        session_factory = async_sessionmaker(engine, expire_on_commit=False)
        suffix = uuid4().hex[:10]
        actor_id = existing_id = batch_id = rollback_batch_id = None
        try:
            async with session_factory() as session:
                actor = User(
                    username=f"import-test-{suffix}",
                    display_name="Import Test",
                    role="superadmin",
                    is_active=True,
                    is_system=False,
                    auth_provider="local",
                )
                existing = DirectoryEntry(
                    display_name=f"Existing {suffix}",
                    department="IT",
                    position="Engineer",
                    email=f"existing-{suffix}@example.test",
                    is_active=True,
                )
                session.add_all([actor, existing])
                await session.flush()
                actor_id = actor.id
                existing_id = existing.id
                batch = DirectoryImportBatch(
                    original_filename="synthetic.csv",
                    file_type="csv",
                    file_sha256="e" * 64,
                    available_sheets=["CSV"],
                    selected_sheet="CSV",
                    parser_mode="table",
                    column_mapping={"0": "display_name"},
                    source_columns=[],
                    status="analyzed",
                    total_source_rows=2,
                    detected_rows=2,
                    selected_rows=2,
                    warning_rows=0,
                    created_by_user_id=actor.id,
                )
                session.add(batch)
                await session.flush()
                batch_id = batch.id
                session.add_all(
                    [
                        DirectoryImportRow(
                            batch_id=batch.id,
                            source_sheet="CSV",
                            source_row_start=2,
                            source_row_end=2,
                            raw_cells={"rows": [{"row": 2, "cells": ["existing"]}]},
                            detected_kind="person",
                            confidence=1.0,
                            normalized_data={
                                "display_name": existing.display_name,
                                "department": "IT",
                                "position": "Lead Engineer",
                                "email": existing.email,
                            },
                            warnings=[],
                            is_selected=True,
                            proposed_action="create",
                            sort_order=0,
                        ),
                        DirectoryImportRow(
                            batch_id=batch.id,
                            source_sheet="CSV",
                            source_row_start=3,
                            source_row_end=3,
                            raw_cells={"rows": [{"row": 3, "cells": ["new"]}]},
                            detected_kind="person",
                            confidence=1.0,
                            normalized_data={
                                "display_name": f"Created {suffix}",
                                "department": "Support",
                            },
                            warnings=[],
                            is_selected=True,
                            proposed_action="create",
                            sort_order=1,
                        ),
                    ]
                )
                await session.commit()

            async with session_factory() as session:
                actor = await session.get(User, actor_id)
                batch = await reconciliation.reconcile_directory_import_batch(
                    session,
                    batch_id,
                    actor=actor,
                )
                self.assertEqual(batch.status, "reconciled")
                self.assertEqual(
                    DirectoryImportBatchPublic.model_validate(batch).status,
                    "reconciled",
                )
                validation = await reconciliation.validate_directory_import_execution(
                    session, batch
                )
                self.assertTrue(validation.can_execute)
                self.assertEqual(validation.create_count, 1)
                self.assertEqual(validation.update_count, 1)
                await session.commit()

            async with session_factory() as session:
                existing = await session.get(DirectoryEntry, existing_id)
                existing.location = "Changed after reconciliation"
                await session.commit()

            async with session_factory() as session:
                actor = await session.get(User, actor_id)
                batch = await session.get(DirectoryImportBatch, batch_id)
                validation = await reconciliation.validate_directory_import_execution(
                    session, batch
                )
                self.assertFalse(validation.can_execute)
                self.assertEqual(validation.stale_count, 1)
                with self.assertRaises(reconciliation.DirectoryImportValidationError) as stale:
                    await reconciliation.execute_directory_import_batch(
                        session,
                        batch_id,
                        actor=actor,
                        version=batch.version,
                        request=None,
                    )
                self.assertEqual(stale.exception.code, "stale_match")
                await session.rollback()

            async with session_factory() as session:
                actor = await session.get(User, actor_id)
                batch = await reconciliation.reconcile_directory_import_batch(
                    session,
                    batch_id,
                    actor=actor,
                )
                validation = await reconciliation.validate_directory_import_execution(
                    session, batch
                )
                self.assertTrue(validation.can_execute)
                version = batch.version
                await session.commit()

            async with session_factory() as session:
                actor = await session.get(User, actor_id)
                result = await reconciliation.execute_directory_import_batch(
                    session,
                    batch_id,
                    actor=actor,
                    version=version,
                    request=None,
                )
                self.assertEqual(result.created, 1)
                self.assertEqual(result.updated, 1)
                await session.commit()

            async with session_factory() as session:
                existing = await session.get(DirectoryEntry, existing_id)
                self.assertEqual(existing.position, "Lead Engineer")
                batch = await session.get(DirectoryImportBatch, batch_id)
                self.assertEqual(batch.status, "completed")
                stored_rows = list(
                    (
                        await session.execute(
                            select(DirectoryImportRow).where(
                                DirectoryImportRow.batch_id == batch_id
                            )
                        )
                    )
                    .scalars()
                    .all()
                )
                self.assertTrue(all(row.raw_cells == {} for row in stored_rows))
                self.assertTrue(all(row.normalized_data == {} for row in stored_rows))
                audit_events = list(
                    (
                        await session.execute(
                            select(AuditEvent).where(
                                AuditEvent.target_id == str(batch_id)
                            )
                        )
                    )
                    .scalars()
                    .all()
                )
                serialized_audit = repr([event.details for event in audit_events]).lower()
                self.assertNotIn(f"existing-{suffix}@example.test", serialized_audit)
                self.assertNotIn("7495", serialized_audit)
                self.assertNotIn("raw_cells", serialized_audit)
                actor = await session.get(User, actor_id)
                retried = await reconciliation.execute_directory_import_batch(
                    session,
                    batch_id,
                    actor=actor,
                    version=version,
                    request=None,
                )
                self.assertEqual(retried.result_entry_ids, result.result_entry_ids)
                batch.status = "executing"
                await session.commit()

            async with session_factory() as session:
                actor = await session.get(User, actor_id)
                with self.assertRaises(reconciliation.DirectoryImportValidationError) as conflict:
                    await reconciliation.execute_directory_import_batch(
                        session,
                        batch_id,
                        actor=actor,
                        version=version,
                        request=None,
                    )
                self.assertEqual(conflict.exception.code, "already_executing")
                await session.rollback()
                batch = await session.get(DirectoryImportBatch, batch_id)
                batch.status = "completed"
                await session.commit()

            async with session_factory() as session:
                rollback_batch = DirectoryImportBatch(
                    original_filename="rollback.csv",
                    file_type="csv",
                    file_sha256="f" * 64,
                    available_sheets=["CSV"],
                    selected_sheet="CSV",
                    parser_mode="table",
                    column_mapping={},
                    source_columns=[],
                    status="analyzed",
                    total_source_rows=2,
                    detected_rows=2,
                    selected_rows=2,
                    warning_rows=0,
                    created_by_user_id=actor_id,
                )
                session.add(rollback_batch)
                await session.flush()
                for index in range(2):
                    session.add(
                        DirectoryImportRow(
                            batch_id=rollback_batch.id,
                            source_sheet="CSV",
                            source_row_start=index + 2,
                            source_row_end=index + 2,
                            raw_cells={"rows": []},
                            detected_kind="person",
                            confidence=1.0,
                            normalized_data={
                                "display_name": f"Rollback {suffix} {index}",
                            },
                            warnings=[],
                            is_selected=True,
                            proposed_action="create",
                            sort_order=index,
                        )
                    )
                await session.commit()
                rollback_batch_id = rollback_batch.id

            async with session_factory() as session:
                actor = await session.get(User, actor_id)
                batch = await reconciliation.reconcile_directory_import_batch(
                    session,
                    rollback_batch_id,
                    actor=actor,
                )
                rollback_version = batch.version
                await session.commit()

            async with session_factory() as session:
                actor = await session.get(User, actor_id)
                original_create = reconciliation.create_directory_entry
                calls = 0

                async def fail_second(*args, **kwargs):
                    nonlocal calls
                    calls += 1
                    if calls == 2:
                        raise RuntimeError("synthetic database failure")
                    return await original_create(*args, **kwargs)

                with patch.object(
                    reconciliation,
                    "create_directory_entry",
                    side_effect=fail_second,
                ):
                    with self.assertRaises(RuntimeError):
                        await reconciliation.execute_directory_import_batch(
                            session,
                            rollback_batch_id,
                            actor=actor,
                            version=rollback_version,
                            request=None,
                        )
                await session.rollback()

            async with session_factory() as session:
                rolled_back = list(
                    (
                        await session.execute(
                            select(DirectoryEntry).where(
                                DirectoryEntry.display_name.like(f"Rollback {suffix}%")
                            )
                        )
                    )
                    .scalars()
                    .all()
                )
                self.assertEqual(rolled_back, [])
                false_audits = list(
                    (
                        await session.execute(
                            select(AuditEvent).where(
                                AuditEvent.actor_user_id == actor_id,
                                AuditEvent.target_label.like(f"Rollback {suffix}%"),
                            )
                        )
                    )
                    .scalars()
                    .all()
                )
                self.assertEqual(false_audits, [])
        finally:
            async with session_factory() as session:
                if batch_id is not None:
                    await session.execute(
                        delete(DirectoryImportBatch).where(
                            DirectoryImportBatch.created_by_user_id == actor_id
                        )
                    )
                if actor_id is not None:
                    await session.execute(
                        delete(AuditEvent).where(AuditEvent.actor_user_id == actor_id)
                    )
                await session.execute(
                    delete(DirectoryEntry).where(
                        DirectoryEntry.display_name.in_(
                            [
                                f"Existing {suffix}",
                                f"Created {suffix}",
                                f"Rollback {suffix} 0",
                                f"Rollback {suffix} 1",
                            ]
                        )
                    )
                )
                if actor_id is not None:
                    await session.execute(delete(User).where(User.id == actor_id))
                await session.commit()
            await engine.dispose()

    async def test_concurrent_batches_cannot_lose_directory_updates(self):
        engine = create_async_engine(
            normalize_async_postgresql_url(settings.database_url),
            pool_pre_ping=True,
        )
        session_factory = async_sessionmaker(engine, expire_on_commit=False)
        suffix = uuid4().hex[:10]
        actor_id = entry_id = None
        batch_ids: list = []
        versions: dict = {}
        try:
            async with session_factory() as session:
                actor = User(
                    username=f"concurrent-import-{suffix}",
                    display_name="Concurrent Import",
                    role="superadmin",
                    is_active=True,
                    is_system=False,
                    auth_provider="local",
                )
                entry = DirectoryEntry(
                    display_name=f"Concurrent Entry {suffix}",
                    department="IT",
                    position="Original",
                    email=f"concurrent-{suffix}@example.test",
                    is_active=True,
                )
                session.add_all([actor, entry])
                await session.flush()
                actor_id = actor.id
                entry_id = entry.id
                for index in range(2):
                    batch = DirectoryImportBatch(
                        original_filename=f"concurrent-{index}.csv",
                        file_type="csv",
                        file_sha256=str(index) * 64,
                        available_sheets=["CSV"],
                        selected_sheet="CSV",
                        parser_mode="table",
                        column_mapping={},
                        source_columns=[],
                        status="analyzed",
                        total_source_rows=1,
                        detected_rows=1,
                        selected_rows=1,
                        warning_rows=0,
                        created_by_user_id=actor.id,
                    )
                    session.add(batch)
                    await session.flush()
                    batch_ids.append(batch.id)
                    session.add(
                        DirectoryImportRow(
                            batch_id=batch.id,
                            source_sheet="CSV",
                            source_row_start=2,
                            source_row_end=2,
                            raw_cells={"rows": []},
                            detected_kind="person",
                            confidence=1.0,
                            normalized_data={
                                "display_name": entry.display_name,
                                "position": f"Concurrent {index}",
                                "email": entry.email,
                            },
                            warnings=[],
                            is_selected=True,
                            proposed_action="create",
                            sort_order=0,
                        )
                    )
                await session.commit()

            for batch_id in batch_ids:
                async with session_factory() as session:
                    actor = await session.get(User, actor_id)
                    batch = await reconciliation.reconcile_directory_import_batch(
                        session,
                        batch_id,
                        actor=actor,
                    )
                    versions[batch_id] = batch.version
                    await session.commit()

            async def execute(batch_id):
                async with session_factory() as session:
                    actor = await session.get(User, actor_id)
                    try:
                        result = await reconciliation.execute_directory_import_batch(
                            session,
                            batch_id,
                            actor=actor,
                            version=versions[batch_id],
                            request=None,
                        )
                        await session.commit()
                        return result
                    except reconciliation.DirectoryImportValidationError as exc:
                        await session.rollback()
                        return exc

            outcomes = await asyncio.gather(*(execute(batch_id) for batch_id in batch_ids))
            completed = [
                item
                for item in outcomes
                if not isinstance(item, reconciliation.DirectoryImportValidationError)
            ]
            conflicts = [
                item
                for item in outcomes
                if isinstance(item, reconciliation.DirectoryImportValidationError)
            ]
            self.assertEqual(len(completed), 1)
            self.assertEqual(len(conflicts), 1)
            self.assertEqual(conflicts[0].code, "stale_match")

            async with session_factory() as session:
                entry = await session.get(DirectoryEntry, entry_id)
                self.assertIn(entry.position, {"Concurrent 0", "Concurrent 1"})
                update_audits = int(
                    await session.scalar(
                        select(func.count(AuditEvent.id)).where(
                            AuditEvent.actor_user_id == actor_id,
                            AuditEvent.event_type == "directory_entry_updated",
                            AuditEvent.target_id == str(entry_id),
                        )
                    )
                    or 0
                )
                self.assertEqual(update_audits, 1)
        finally:
            async with session_factory() as session:
                if actor_id is not None:
                    await session.execute(
                        delete(DirectoryImportBatch).where(
                            DirectoryImportBatch.created_by_user_id == actor_id
                        )
                    )
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

    async def test_concurrent_batches_cannot_create_duplicate_entries(self):
        engine = create_async_engine(
            normalize_async_postgresql_url(settings.database_url),
            pool_pre_ping=True,
        )
        session_factory = async_sessionmaker(engine, expire_on_commit=False)
        suffix = uuid4().hex[:10]
        display_name = f"Concurrent Create {suffix}"
        email = f"concurrent-create-{suffix}@example.com"
        actor_id = None
        batch_ids: list = []
        versions: dict = {}
        try:
            async with session_factory() as session:
                actor = User(
                    username=f"concurrent-create-{suffix}",
                    display_name="Concurrent Create",
                    role="superadmin",
                    is_active=True,
                    is_system=False,
                    auth_provider="local",
                )
                session.add(actor)
                await session.flush()
                actor_id = actor.id
                for index in range(2):
                    batch = DirectoryImportBatch(
                        original_filename=f"concurrent-create-{index}.csv",
                        file_type="csv",
                        file_sha256=str(index + 2) * 64,
                        available_sheets=["CSV"],
                        selected_sheet="CSV",
                        parser_mode="table",
                        column_mapping={},
                        source_columns=[],
                        status="analyzed",
                        total_source_rows=1,
                        detected_rows=1,
                        selected_rows=1,
                        warning_rows=0,
                        created_by_user_id=actor.id,
                    )
                    session.add(batch)
                    await session.flush()
                    batch_ids.append(batch.id)
                    session.add(
                        DirectoryImportRow(
                            batch_id=batch.id,
                            source_sheet="CSV",
                            source_row_start=2,
                            source_row_end=2,
                            raw_cells={"rows": []},
                            detected_kind="person",
                            confidence=1.0,
                            normalized_data={
                                "display_name": display_name,
                                "email": email,
                            },
                            warnings=[],
                            is_selected=True,
                            proposed_action="create",
                            sort_order=0,
                        )
                    )
                await session.commit()

            for batch_id in batch_ids:
                async with session_factory() as session:
                    actor = await session.get(User, actor_id)
                    batch = await reconciliation.reconcile_directory_import_batch(
                        session,
                        batch_id,
                        actor=actor,
                    )
                    versions[batch_id] = batch.version
                    await session.commit()

            async def execute(batch_id):
                async with session_factory() as session:
                    actor = await session.get(User, actor_id)
                    try:
                        result = await reconciliation.execute_directory_import_batch(
                            session,
                            batch_id,
                            actor=actor,
                            version=versions[batch_id],
                            request=None,
                        )
                        await session.commit()
                        return result
                    except reconciliation.DirectoryImportValidationError as exc:
                        await session.rollback()
                        return exc

            outcomes = await asyncio.gather(*(execute(batch_id) for batch_id in batch_ids))
            completed = [
                item
                for item in outcomes
                if not isinstance(item, reconciliation.DirectoryImportValidationError)
            ]
            conflicts = [
                item
                for item in outcomes
                if isinstance(item, reconciliation.DirectoryImportValidationError)
            ]
            self.assertEqual(len(completed), 1)
            self.assertEqual(len(conflicts), 1)
            self.assertEqual(conflicts[0].code, "stale_match")

            async with session_factory() as session:
                entry_count = int(
                    await session.scalar(
                        select(func.count(DirectoryEntry.id)).where(
                            DirectoryEntry.email == email
                        )
                    )
                    or 0
                )
                self.assertEqual(entry_count, 1)
        finally:
            async with session_factory() as session:
                if actor_id is not None:
                    await session.execute(
                        delete(DirectoryImportBatch).where(
                            DirectoryImportBatch.created_by_user_id == actor_id
                        )
                    )
                    await session.execute(
                        delete(AuditEvent).where(AuditEvent.actor_user_id == actor_id)
                    )
                await session.execute(
                    delete(DirectoryEntry).where(DirectoryEntry.email == email)
                )
                if actor_id is not None:
                    await session.execute(delete(User).where(User.id == actor_id))
                await session.commit()
            await engine.dispose()

    async def test_batch_lock_serializes_execute_reconcile_and_row_patch(self):
        engine = create_async_engine(
            normalize_async_postgresql_url(settings.database_url),
            pool_pre_ping=True,
        )
        session_factory = async_sessionmaker(engine, expire_on_commit=False)
        suffix = uuid4().hex[:10]
        actor_id = batch_id = row_id = None
        created_name = f"Serialized Import {suffix}"
        entered_create = asyncio.Event()
        release_create = asyncio.Event()
        try:
            async with session_factory() as session:
                actor = User(
                    username=f"serialized-import-{suffix}",
                    display_name="Serialized Import",
                    role="superadmin",
                    is_active=True,
                    is_system=False,
                    auth_provider="local",
                )
                session.add(actor)
                await session.flush()
                actor_id = actor.id
                batch = DirectoryImportBatch(
                    original_filename="serialized.csv",
                    file_type="csv",
                    file_sha256="8" * 64,
                    available_sheets=["CSV"],
                    selected_sheet="CSV",
                    parser_mode="table",
                    column_mapping={},
                    source_columns=[],
                    status="analyzed",
                    total_source_rows=1,
                    detected_rows=1,
                    selected_rows=1,
                    warning_rows=0,
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
                    normalized_data={"display_name": created_name},
                    warnings=[],
                    is_selected=True,
                    proposed_action="create",
                    sort_order=0,
                )
                session.add(row)
                await session.commit()
                row_id = row.id

            async with session_factory() as session:
                actor = await session.get(User, actor_id)
                batch = await reconciliation.reconcile_directory_import_batch(
                    session,
                    batch_id,
                    actor=actor,
                )
                version = batch.version
                await session.commit()

            original_create = reconciliation.create_directory_entry

            async def pause_after_create(*args, **kwargs):
                entry = await original_create(*args, **kwargs)
                entered_create.set()
                await release_create.wait()
                return entry

            async def execute_once():
                async with session_factory() as session:
                    actor = await session.get(User, actor_id)
                    result = await reconciliation.execute_directory_import_batch(
                        session,
                        batch_id,
                        actor=actor,
                        version=version,
                        request=None,
                    )
                    await session.commit()
                    return result

            async def patch_once():
                async with session_factory() as session:
                    actor = await session.get(User, actor_id)
                    try:
                        await reconciliation.update_directory_import_match(
                            session,
                            batch_id,
                            row_id,
                            DirectoryImportMatchUpdate(
                                proposed_action="skip",
                                version=version,
                            ),
                            actor=actor,
                        )
                    except reconciliation.DirectoryImportValidationError as exc:
                        await session.rollback()
                        return exc
                    raise AssertionError("Row patch unexpectedly succeeded")

            async def reconcile_once():
                async with session_factory() as session:
                    actor = await session.get(User, actor_id)
                    try:
                        await reconciliation.reconcile_directory_import_batch(
                            session,
                            batch_id,
                            actor=actor,
                        )
                    except reconciliation.DirectoryImportValidationError as exc:
                        await session.rollback()
                        return exc
                    raise AssertionError("Concurrent reconciliation unexpectedly succeeded")

            with patch.object(
                reconciliation,
                "create_directory_entry",
                side_effect=pause_after_create,
            ):
                first_execute = asyncio.create_task(execute_once())
                await asyncio.wait_for(entered_create.wait(), timeout=5)
                retry_execute = asyncio.create_task(execute_once())
                patch_task = asyncio.create_task(patch_once())
                reconcile_task = asyncio.create_task(reconcile_once())
                await asyncio.sleep(0.2)
                self.assertFalse(retry_execute.done())
                self.assertFalse(patch_task.done())
                self.assertFalse(reconcile_task.done())
                release_create.set()
                first_result, retry_result, patch_result, reconcile_result = (
                    await asyncio.gather(
                        first_execute,
                        retry_execute,
                        patch_task,
                        reconcile_task,
                    )
                )

            self.assertEqual(
                first_result.result_entry_ids,
                retry_result.result_entry_ids,
            )
            self.assertEqual(patch_result.code, "invalid_state")
            self.assertEqual(reconcile_result.code, "invalid_state")

            async with session_factory() as session:
                created_count = int(
                    await session.scalar(
                        select(func.count(DirectoryEntry.id)).where(
                            DirectoryEntry.display_name == created_name
                        )
                    )
                    or 0
                )
                self.assertEqual(created_count, 1)
                completed_audits = int(
                    await session.scalar(
                        select(func.count(AuditEvent.id)).where(
                            AuditEvent.actor_user_id == actor_id,
                            AuditEvent.event_type == "directory_import_completed",
                            AuditEvent.target_id == str(batch_id),
                        )
                    )
                    or 0
                )
                self.assertEqual(completed_audits, 1)
        finally:
            release_create.set()
            async with session_factory() as session:
                if actor_id is not None:
                    await session.execute(
                        delete(DirectoryImportBatch).where(
                            DirectoryImportBatch.created_by_user_id == actor_id
                        )
                    )
                    await session.execute(
                        delete(AuditEvent).where(AuditEvent.actor_user_id == actor_id)
                    )
                await session.execute(
                    delete(DirectoryEntry).where(
                        DirectoryEntry.display_name == created_name
                    )
                )
                if actor_id is not None:
                    await session.execute(delete(User).where(User.id == actor_id))
                await session.commit()
            await engine.dispose()

    async def test_rollback_removes_create_update_restore_and_success_audits(self):
        engine = create_async_engine(
            normalize_async_postgresql_url(settings.database_url),
            pool_pre_ping=True,
        )
        session_factory = async_sessionmaker(engine, expire_on_commit=False)
        suffix = uuid4().hex[:10]
        actor_id = active_id = archived_id = batch_id = None
        created_name = f"Rollback Created {suffix}"
        try:
            async with session_factory() as session:
                actor = User(
                    username=f"rollback-all-{suffix}",
                    display_name="Rollback All",
                    role="superadmin",
                    is_active=True,
                    is_system=False,
                    auth_provider="local",
                )
                active = DirectoryEntry(
                    display_name=f"Rollback Active {suffix}",
                    position="Original active",
                    email=f"rollback-active-{suffix}@example.test",
                    is_active=True,
                )
                archived = DirectoryEntry(
                    display_name=f"Rollback Archived {suffix}",
                    position="Original archived",
                    email=f"rollback-archived-{suffix}@example.test",
                    is_active=False,
                )
                session.add_all([actor, active, archived])
                await session.flush()
                actor_id = actor.id
                active_id = active.id
                archived_id = archived.id
                batch = DirectoryImportBatch(
                    original_filename="rollback-all.csv",
                    file_type="csv",
                    file_sha256="9" * 64,
                    available_sheets=["CSV"],
                    selected_sheet="CSV",
                    parser_mode="table",
                    column_mapping={},
                    source_columns=[],
                    status="reconciled",
                    total_source_rows=3,
                    detected_rows=3,
                    selected_rows=3,
                    warning_rows=0,
                    created_by_user_id=actor.id,
                    version=2,
                )
                session.add(batch)
                await session.flush()
                batch_id = batch.id
                session.add_all(
                    [
                        DirectoryImportRow(
                            batch_id=batch.id,
                            source_sheet="CSV",
                            source_row_start=2,
                            source_row_end=2,
                            raw_cells={"rows": []},
                            detected_kind="person",
                            confidence=1.0,
                            normalized_data={"display_name": created_name},
                            warnings=[],
                            is_selected=True,
                            proposed_action="create",
                            match_status="unmatched",
                            sort_order=0,
                        ),
                        DirectoryImportRow(
                            batch_id=batch.id,
                            source_sheet="CSV",
                            source_row_start=3,
                            source_row_end=3,
                            raw_cells={"rows": []},
                            detected_kind="person",
                            confidence=1.0,
                            normalized_data={"position": "Changed active"},
                            warnings=[],
                            is_selected=True,
                            proposed_action="update",
                            match_status="exact",
                            matched_entry_id=active.id,
                            update_fields=["position"],
                            expected_entry_updated_at=active.updated_at,
                            sort_order=1,
                        ),
                        DirectoryImportRow(
                            batch_id=batch.id,
                            source_sheet="CSV",
                            source_row_start=4,
                            source_row_end=4,
                            raw_cells={"rows": []},
                            detected_kind="person",
                            confidence=1.0,
                            normalized_data={"position": "Changed archived"},
                            warnings=[],
                            is_selected=True,
                            proposed_action="update",
                            match_status="archived_match",
                            matched_entry_id=archived.id,
                            update_fields=["position"],
                            restore_if_archived=True,
                            expected_entry_updated_at=archived.updated_at,
                            sort_order=2,
                        ),
                    ]
                )
                await session.commit()

            async with session_factory() as session:
                actor = await session.get(User, actor_id)
                original_audit = reconciliation.record_audit_event

                async def fail_after_completed_audit(*args, **kwargs):
                    event = await original_audit(*args, **kwargs)
                    if kwargs.get("event_type") == "directory_import_completed":
                        raise RuntimeError("synthetic failure after audit")
                    return event

                with patch.object(
                    reconciliation,
                    "record_audit_event",
                    side_effect=fail_after_completed_audit,
                ):
                    with self.assertRaises(RuntimeError):
                        await reconciliation.execute_directory_import_batch(
                            session,
                            batch_id,
                            actor=actor,
                            version=2,
                            request=None,
                        )
                await session.rollback()

            async with session_factory() as session:
                active = await session.get(DirectoryEntry, active_id)
                archived = await session.get(DirectoryEntry, archived_id)
                self.assertEqual(active.position, "Original active")
                self.assertEqual(archived.position, "Original archived")
                self.assertFalse(archived.is_active)
                self.assertIsNone(
                    await session.scalar(
                        select(DirectoryEntry).where(
                            DirectoryEntry.display_name == created_name
                        )
                    )
                )
                batch = await session.get(DirectoryImportBatch, batch_id)
                self.assertEqual(batch.status, "reconciled")
                rows = list(
                    (
                        await session.execute(
                            select(DirectoryImportRow).where(
                                DirectoryImportRow.batch_id == batch_id
                            )
                        )
                    )
                    .scalars()
                    .all()
                )
                self.assertTrue(
                    all(
                        row.execution_status == "pending"
                        and row.result_entry_id is None
                        for row in rows
                    )
                )
                false_success_audits = list(
                    (
                        await session.execute(
                            select(AuditEvent).where(
                                AuditEvent.actor_user_id == actor_id,
                                AuditEvent.event_type.in_(
                                    {
                                        "directory_import_execution_started",
                                        "directory_import_completed",
                                        "directory_entry_created",
                                        "directory_entry_updated",
                                        "directory_entry_restored",
                                    }
                                ),
                            )
                        )
                    )
                    .scalars()
                    .all()
                )
                self.assertEqual(false_success_audits, [])

            async with session_factory() as session:
                actor = await session.get(User, actor_id)
                await reconciliation.mark_directory_import_execution_failed(
                    session,
                    batch_id,
                    actor=actor,
                    request=None,
                )
                await session.commit()

            async with session_factory() as session:
                batch = await session.get(DirectoryImportBatch, batch_id)
                self.assertEqual(batch.status, "failed")
                self.assertEqual(batch.execution_error, "execution_failed")
                failed_audits = list(
                    (
                        await session.execute(
                            select(AuditEvent).where(
                                AuditEvent.actor_user_id == actor_id,
                                AuditEvent.event_type == "directory_import_failed",
                                AuditEvent.target_id == str(batch_id),
                            )
                        )
                    )
                    .scalars()
                    .all()
                )
                self.assertEqual(len(failed_audits), 1)
                self.assertEqual(
                    failed_audits[0].details,
                    {"batch_id": str(batch_id)},
                )
                actor = await session.get(User, actor_id)
                with self.assertRaises(
                    reconciliation.DirectoryImportValidationError
                ) as failed_retry:
                    await reconciliation.execute_directory_import_batch(
                        session,
                        batch_id,
                        actor=actor,
                        version=2,
                        request=None,
                    )
                self.assertEqual(failed_retry.exception.code, "invalid_state")
                await session.rollback()
        finally:
            async with session_factory() as session:
                if actor_id is not None:
                    await session.execute(
                        delete(DirectoryImportBatch).where(
                            DirectoryImportBatch.created_by_user_id == actor_id
                        )
                    )
                    await session.execute(
                        delete(AuditEvent).where(AuditEvent.actor_user_id == actor_id)
                    )
                await session.execute(
                    delete(DirectoryEntry).where(
                        DirectoryEntry.id.in_(
                            [item for item in (active_id, archived_id) if item is not None]
                        )
                    )
                )
                await session.execute(
                    delete(DirectoryEntry).where(
                        DirectoryEntry.display_name == created_name
                    )
                )
                if actor_id is not None:
                    await session.execute(delete(User).where(User.id == actor_id))
                await session.commit()
            await engine.dispose()

    async def test_archived_match_requires_explicit_restore_and_updates_atomically(self):
        engine = create_async_engine(
            normalize_async_postgresql_url(settings.database_url),
            pool_pre_ping=True,
        )
        session_factory = async_sessionmaker(engine, expire_on_commit=False)
        suffix = uuid4().hex[:10]
        actor_id = entry_id = batch_id = None
        try:
            async with session_factory() as session:
                actor = User(
                    username=f"restore-test-{suffix}",
                    display_name="Restore Test",
                    role="superadmin",
                    is_active=True,
                    is_system=False,
                    auth_provider="local",
                )
                entry = DirectoryEntry(
                    display_name=f"Archived {suffix}",
                    department="Archive",
                    position="Old position",
                    email=f"archived-{suffix}@example.test",
                    is_active=False,
                )
                session.add_all([actor, entry])
                await session.flush()
                actor_id = actor.id
                entry_id = entry.id
                batch = DirectoryImportBatch(
                    original_filename="restore.csv",
                    file_type="csv",
                    file_sha256="a" * 64,
                    available_sheets=["CSV"],
                    selected_sheet="CSV",
                    parser_mode="table",
                    column_mapping={},
                    source_columns=[],
                    status="analyzed",
                    total_source_rows=1,
                    detected_rows=1,
                    selected_rows=1,
                    warning_rows=0,
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
                    raw_cells={"rows": [{"row": 2, "cells": ["archived"]}]},
                    detected_kind="person",
                    confidence=1.0,
                    normalized_data={
                        "display_name": entry.display_name,
                        "department": entry.department,
                        "position": "Restored position",
                        "email": entry.email,
                    },
                    warnings=[],
                    is_selected=True,
                    proposed_action="create",
                    sort_order=0,
                )
                session.add(row)
                await session.commit()
                row_id = row.id

            async with session_factory() as session:
                actor = await session.get(User, actor_id)
                batch = await reconciliation.reconcile_directory_import_batch(
                    session, batch_id, actor=actor
                )
                row = await session.get(DirectoryImportRow, row_id)
                self.assertEqual(row.match_status, "archived_match")
                self.assertEqual(row.proposed_action, "skip")
                row = await reconciliation.update_directory_import_match(
                    session,
                    batch_id,
                    row_id,
                    DirectoryImportMatchUpdate(
                        proposed_action="update",
                        matched_entry_id=entry_id,
                        update_fields=["position"],
                        restore_if_archived=True,
                        version=batch.version,
                    ),
                    actor=actor,
                )
                validation = await reconciliation.validate_directory_import_execution(
                    session, batch
                )
                self.assertTrue(validation.can_execute)
                self.assertEqual(validation.restore_count, 1)
                version = batch.version
                await session.commit()

            async with session_factory() as session:
                actor = await session.get(User, actor_id)
                result = await reconciliation.execute_directory_import_batch(
                    session,
                    batch_id,
                    actor=actor,
                    version=version,
                    request=None,
                )
                self.assertEqual(result.restored, 1)
                self.assertEqual(result.updated, 0)
                await session.commit()

            async with session_factory() as session:
                entry = await session.get(DirectoryEntry, entry_id)
                self.assertTrue(entry.is_active)
                self.assertEqual(entry.position, "Restored position")
        finally:
            async with session_factory() as session:
                if batch_id is not None:
                    await session.execute(
                        delete(DirectoryImportBatch).where(
                            DirectoryImportBatch.id == batch_id
                        )
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
