import unittest
from datetime import datetime, timezone
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch
from uuid import uuid4

from fastapi import HTTPException
from pydantic import ValidationError
from sqlalchemy.dialects import postgresql
from sqlalchemy.exc import IntegrityError

from app.api import deps
from app.api.routes import directory as directory_routes
from app.core.permissions import CAN_MANAGE_DIRECTORY, PERMISSION_CATALOG
from app.models.directory import DirectoryEntry
from app.schemas.directory import (
    DirectoryEntryCreate,
    DirectoryEntryPermanentDelete,
    DirectoryEntryPublic,
    DirectoryEntryUpdate,
)
from app.services import directory


def user(**overrides):
    values = {
        "id": uuid4(),
        "username": "employee",
        "display_name": "Employee",
        "role": "user",
        "is_active": True,
        "auth_provider": "local",
    }
    values.update(overrides)
    return SimpleNamespace(**values)


def entry(**overrides):
    now = datetime(2026, 7, 25, 10, 0, tzinfo=timezone.utc)
    values = {
        "id": uuid4(),
        "display_name": "Dmitrii Fedorov",
        "department": "IT",
        "position": "Engineer",
        "internal_phone": "1234",
        "work_phone": "+7 (495) 123-45-67",
        "mobile_phone": None,
        "email": "dmitrii@example.com",
        "room": "501",
        "location": "Main office",
        "notes": None,
        "linked_user_id": None,
        "is_active": True,
        "created_at": now,
        "updated_at": now,
        "created_by_user_id": None,
        "updated_by_user_id": None,
    }
    values.update(overrides)
    model = DirectoryEntry(**values)
    model.linked_user = None
    return model


def request():
    return SimpleNamespace(client=None, headers={}, state=SimpleNamespace(request_id="request-1"))


class MutationSession:
    def __init__(self):
        self.commits = 0
        self.rollbacks = 0

    async def commit(self):
        self.commits += 1

    async def rollback(self):
        self.rollbacks += 1


class DirectoryFoundationTests(unittest.TestCase):
    def test_directory_permission_is_cataloged(self):
        self.assertIn(CAN_MANAGE_DIRECTORY, PERMISSION_CATALOG)
        self.assertEqual(PERMISSION_CATALOG[CAN_MANAGE_DIRECTORY]["category"], "directory")

    def test_display_name_and_email_validation(self):
        with self.assertRaises(ValidationError):
            DirectoryEntryCreate(display_name="   ", email="employee@example.com")
        with self.assertRaises(ValidationError):
            DirectoryEntryCreate(display_name="Employee", email="invalid-email")
        with self.assertRaises(ValidationError):
            DirectoryEntryUpdate(display_name=None)

        payload = DirectoryEntryCreate(display_name="  Employee  ", email="employee@example.com")
        self.assertEqual(payload.display_name, "Employee")
        self.assertEqual(str(payload.email), "employee@example.com")

    def test_directory_response_contains_only_safe_linked_user_summary(self):
        linked_user = user(
            username="dmitrii",
            display_name="Dmitrii Fedorov",
            email="private@example.com",
            role="admin",
            permissions=["can_manage_directory"],
            is_active=True,
        )
        model = entry(linked_user_id=linked_user.id)
        model.linked_user = linked_user

        payload = DirectoryEntryPublic.model_validate(model).model_dump(mode="json")

        self.assertEqual(
            payload["linked_user"],
            {
                "id": str(linked_user.id),
                "username": "dmitrii",
                "display_name": "Dmitrii Fedorov",
                "is_active": True,
            },
        )
        self.assertNotIn("email", payload["linked_user"])
        self.assertNotIn("permissions", payload["linked_user"])
        self.assertNotIn("role", payload["linked_user"])

    def test_directory_response_handles_null_and_inactive_linked_users(self):
        without_link = DirectoryEntryPublic.model_validate(entry()).model_dump(mode="json")
        self.assertIsNone(without_link["linked_user"])

        linked_user = user(username="disabled", display_name="Disabled User", is_active=False)
        model = entry(linked_user_id=linked_user.id)
        model.linked_user = linked_user
        payload = DirectoryEntryPublic.model_validate(model).model_dump(mode="json")

        self.assertEqual(payload["linked_user"]["is_active"], False)
        self.assertEqual(payload["linked_user"]["username"], "disabled")

    def test_phone_search_removes_formatting(self):
        self.assertEqual(directory.normalize_phone_search("+7 (495) 123-45-67"), "74951234567")

        condition = directory.build_search_conditions("7 495 123-45-67")[0]
        sql = str(
            condition.compile(
                dialect=postgresql.dialect(),
                compile_kwargs={"literal_binds": True},
            )
        )
        self.assertIn("regexp_replace", sql)
        self.assertIn("internal_phone", sql)
        self.assertIn("work_phone", sql)
        self.assertIn("mobile_phone", sql)
        self.assertIn("74951234567", sql)

    def test_text_search_covers_required_fields(self):
        condition = directory.build_search_conditions("engineering")[0]
        sql = str(condition.compile(dialect=postgresql.dialect()))
        for field in (
            "display_name",
            "department",
            "position",
            "email",
            "room",
            "location",
        ):
            self.assertIn(field, sql)

    def test_text_search_treats_like_metacharacters_as_literals(self):
        self.assertEqual(directory.escape_like_search(r"100%_done"), r"100\%\_done")
        condition = directory.build_search_conditions(r"100%_done")[0]
        sql = str(
            condition.compile(
                dialect=postgresql.dialect(),
                compile_kwargs={"literal_binds": True},
            )
        )
        self.assertIn("ESCAPE", sql)
        self.assertIn(r"100\\%%\\_done", sql)

    def test_empty_search_adds_no_conditions(self):
        self.assertEqual(directory.build_search_conditions("   "), ())


class DirectoryPermissionTests(unittest.IsolatedAsyncioTestCase):
    async def test_manage_dependency_uses_existing_permission_service(self):
        actor = user()
        session = AsyncMock()
        with patch("app.api.deps.require_permission", AsyncMock()) as require:
            returned = await deps.require_can_manage_directory(session, actor)
        self.assertIs(returned, actor)
        require.assert_awaited_once_with(session, actor, CAN_MANAGE_DIRECTORY)

    async def test_regular_user_can_list_active_entries(self):
        actor = user()
        with (
            patch.object(directory_routes, "can_manage_directory", AsyncMock(return_value=False)),
            patch.object(directory_routes, "list_directory_entries", AsyncMock(return_value=([], 0))) as listing,
        ):
            result = await directory_routes.get_directory_entries(
                AsyncMock(), actor, None, None, "active", 1, 30
            )
        self.assertEqual(result.total, 0)
        listing.assert_awaited_once_with(
            unittest.mock.ANY,
            search=None,
            department=None,
            include_inactive=False,
            only_inactive=False,
            page=1,
            limit=30,
        )

    async def test_regular_user_cannot_list_archived_entries(self):
        with patch.object(directory_routes, "can_manage_directory", AsyncMock(return_value=False)):
            with self.assertRaises(HTTPException) as raised:
                await directory_routes.get_directory_entries(
                    AsyncMock(), user(), None, None, "all", 1, 30
                )
        self.assertEqual(raised.exception.status_code, 403)

    async def test_manager_can_filter_and_paginate_all_entries(self):
        session = AsyncMock()
        with (
            patch.object(directory_routes, "can_manage_directory", AsyncMock(return_value=True)),
            patch.object(directory_routes, "list_directory_entries", AsyncMock(return_value=([], 61))) as listing,
        ):
            result = await directory_routes.get_directory_entries(
                session, user(), "Dmitrii", "IT", "all", 3, 30
            )
        self.assertEqual((result.page, result.limit, result.total), (3, 30, 61))
        listing.assert_awaited_once_with(
            session,
            search="Dmitrii",
            department="IT",
            include_inactive=True,
            only_inactive=False,
            page=3,
            limit=30,
        )

    async def test_manager_can_list_only_archived_entries(self):
        session = AsyncMock()
        with (
            patch.object(directory_routes, "can_manage_directory", AsyncMock(return_value=True)),
            patch.object(
                directory_routes,
                "list_directory_entries",
                AsyncMock(return_value=([], 2)),
            ) as listing,
        ):
            result = await directory_routes.get_directory_entries(
                session, user(), None, None, "archived", 1, 30
            )
        self.assertEqual(result.total, 2)
        listing.assert_awaited_once_with(
            session,
            search=None,
            department=None,
            include_inactive=True,
            only_inactive=True,
            page=1,
            limit=30,
        )

    async def test_archived_entry_is_hidden_from_regular_get(self):
        archived = entry(is_active=False)
        with (
            patch.object(directory_routes, "can_manage_directory", AsyncMock(return_value=False)),
            patch.object(
                directory_routes,
                "get_directory_entry",
                AsyncMock(side_effect=directory.DirectoryEntryNotFoundError()),
            ) as getter,
        ):
            with self.assertRaises(HTTPException) as raised:
                await directory_routes.get_directory_entry_route(
                    archived.id, AsyncMock(), user()
                )
        self.assertEqual(raised.exception.status_code, 404)
        getter.assert_awaited_once_with(
            unittest.mock.ANY, archived.id, include_inactive=False
        )


class DirectoryMutationTests(unittest.IsolatedAsyncioTestCase):
    def delete_payload(self, current, **overrides):
        values = {
            "confirmation_name": current.display_name,
            "reason": "test_data",
            "expected_updated_at": current.updated_at,
        }
        values.update(overrides)
        return DirectoryEntryPermanentDelete(**values)

    async def test_missing_linked_user_is_rejected(self):
        session = AsyncMock()
        session.get.return_value = None
        with self.assertRaises(directory.DirectoryLinkedUserNotFoundError):
            await directory.ensure_linked_user_exists(session, uuid4())

    async def test_disabled_linked_user_remains_a_valid_directory_link(self):
        session = AsyncMock()
        session.get.return_value = user(is_active=False)
        await directory.ensure_linked_user_exists(session, uuid4())

    async def test_update_reports_only_changed_fields(self):
        actor = user()
        current = entry()
        session = AsyncMock()
        session.get.return_value = None
        with patch.object(
            directory,
            "get_directory_entry",
            AsyncMock(return_value=current),
        ):
            updated, changed = await directory.update_directory_entry(
                session,
                current,
                DirectoryEntryUpdate(display_name="Dmitrii Updated", room="501"),
                actor,
            )
        self.assertIs(updated, current)
        self.assertEqual(changed, ["display_name"])
        self.assertEqual(current.updated_by_user_id, actor.id)

    async def test_noop_update_does_not_change_actor_metadata(self):
        actor = user()
        current = entry(updated_by_user_id=None)
        session = AsyncMock()
        with patch.object(
            directory,
            "get_directory_entry",
            AsyncMock(return_value=current),
        ):
            updated, changed = await directory.update_directory_entry(
                session,
                current,
                DirectoryEntryUpdate(display_name=current.display_name),
                actor,
            )
        self.assertIs(updated, current)
        self.assertEqual(changed, [])
        self.assertIsNone(current.updated_by_user_id)
        session.flush.assert_not_awaited()
        session.refresh.assert_not_awaited()

    async def test_repeated_archive_and_restore_are_conflicts(self):
        session = AsyncMock()
        actor = user()
        with self.assertRaises(directory.DirectoryStateConflictError):
            await directory.set_directory_entry_active(
                session,
                entry(is_active=False),
                actor,
                is_active=False,
            )
        with self.assertRaises(directory.DirectoryStateConflictError):
            await directory.set_directory_entry_active(
                session,
                entry(is_active=True),
                actor,
                is_active=True,
            )
        session.flush.assert_not_awaited()

    async def test_noop_patch_and_state_conflict_do_not_write_false_audit_events(self):
        actor = user()
        current = entry()
        session = MutationSession()
        with (
            patch.object(
                directory_routes,
                "get_directory_entry",
                AsyncMock(return_value=current),
            ),
            patch.object(
                directory_routes,
                "update_directory_entry",
                AsyncMock(return_value=(current, [])),
            ),
            patch.object(directory_routes, "record_audit_event", AsyncMock()) as record,
        ):
            await directory_routes.patch_directory_entry(
                current.id,
                DirectoryEntryUpdate(),
                request(),
                session,
                actor,
            )
        record.assert_not_awaited()
        self.assertEqual(session.commits, 1)

        with (
            patch.object(
                directory_routes,
                "get_directory_entry",
                AsyncMock(return_value=current),
            ),
            patch.object(
                directory_routes,
                "set_directory_entry_active",
                AsyncMock(
                    side_effect=directory.DirectoryStateConflictError(
                        "Directory entry is already archived"
                    )
                ),
            ),
            patch.object(directory_routes, "record_audit_event", AsyncMock()) as record,
        ):
            with self.assertRaises(HTTPException) as raised:
                await directory_routes.post_directory_entry_archive(
                    current.id,
                    request(),
                    session,
                    actor,
                )
        self.assertEqual(raised.exception.status_code, 409)
        record.assert_not_awaited()
        self.assertEqual(session.rollbacks, 1)

    async def test_linked_user_audit_records_only_the_safe_identifier(self):
        actor = user()
        linked_user_id = uuid4()
        current = entry(linked_user_id=linked_user_id)
        session = MutationSession()
        with (
            patch.object(
                directory_routes,
                "create_directory_entry",
                AsyncMock(return_value=current),
            ),
            patch.object(directory_routes, "record_audit_event", AsyncMock()) as record,
        ):
            await directory_routes.post_directory_entry(
                DirectoryEntryCreate(
                    display_name=current.display_name,
                    linked_user_id=linked_user_id,
                ),
                request(),
                session,
                actor,
            )
        self.assertEqual(
            record.await_args.kwargs["details"],
            {"is_active": True, "linked_user_id": str(linked_user_id)},
        )

        with (
            patch.object(
                directory_routes,
                "get_directory_entry",
                AsyncMock(return_value=current),
            ),
            patch.object(
                directory_routes,
                "update_directory_entry",
                AsyncMock(return_value=(current, ["linked_user_id"])),
            ),
            patch.object(directory_routes, "record_audit_event", AsyncMock()) as record,
        ):
            await directory_routes.patch_directory_entry(
                current.id,
                DirectoryEntryUpdate(linked_user_id=linked_user_id),
                request(),
                session,
                actor,
            )
        self.assertEqual(
            record.await_args.kwargs["details"],
            {
                "changed_fields": ["linked_user_id"],
                "linked_user_id": str(linked_user_id),
            },
        )

    async def test_mutations_write_expected_audit_events(self):
        actor = user()
        current = entry()
        session = MutationSession()
        cases = [
            (
                directory_routes.post_directory_entry,
                (
                    DirectoryEntryCreate(display_name=current.display_name),
                    request(),
                    session,
                    actor,
                ),
                "directory_entry_created",
                patch.object(
                    directory_routes,
                    "create_directory_entry",
                    AsyncMock(return_value=current),
                ),
            ),
            (
                directory_routes.patch_directory_entry,
                (
                    current.id,
                    DirectoryEntryUpdate(display_name="Updated"),
                    request(),
                    session,
                    actor,
                ),
                "directory_entry_updated",
                patch.object(
                    directory_routes,
                    "update_directory_entry",
                    AsyncMock(return_value=(current, ["display_name"])),
                ),
            ),
            (
                directory_routes.post_directory_entry_archive,
                (current.id, request(), session, actor),
                "directory_entry_archived",
                patch.object(
                    directory_routes,
                    "set_directory_entry_active",
                    AsyncMock(return_value=current),
                ),
            ),
            (
                directory_routes.post_directory_entry_restore,
                (current.id, request(), session, actor),
                "directory_entry_restored",
                patch.object(
                    directory_routes,
                    "set_directory_entry_active",
                    AsyncMock(return_value=current),
                ),
            ),
        ]

        for route, args, expected_event, mutation_patch in cases:
            with (
                patch.object(
                    directory_routes,
                    "get_directory_entry",
                    AsyncMock(return_value=current),
                ),
                mutation_patch,
                patch.object(
                    directory_routes,
                    "record_audit_event",
                    AsyncMock(),
                ) as record,
            ):
                await route(*args)
            self.assertEqual(record.await_args.kwargs["event_type"], expected_event)

        self.assertEqual(session.commits, 4)
        self.assertEqual(session.rollbacks, 0)

    async def test_only_superadmin_can_permanently_delete(self):
        current = entry(is_active=False)
        for role in ("admin", "user"):
            session = AsyncMock()
            with self.assertRaises(directory.DirectoryPermanentDeleteError) as raised:
                await directory.permanently_delete_directory_entry(
                    session,
                    current.id,
                    self.delete_payload(current),
                    user(role=role),
                    request(),
                )
            self.assertEqual(raised.exception.code, "directory_entry_delete_forbidden")
            session.execute.assert_not_awaited()
            session.delete.assert_not_awaited()

    async def test_permanent_delete_requires_archived_unlinked_current_entry(self):
        actor = user(role="superadmin")
        cases = (
            (entry(is_active=True), "directory_entry_must_be_archived"),
            (entry(is_active=False, linked_user_id=uuid4()), "directory_entry_linked_user"),
        )
        for current, expected_code in cases:
            session = AsyncMock()
            with (
                patch.object(
                    directory,
                    "get_directory_entry",
                    AsyncMock(return_value=current),
                ),
                patch.object(directory, "record_audit_event", AsyncMock()) as audit,
            ):
                with self.assertRaises(directory.DirectoryPermanentDeleteError) as raised:
                    await directory.permanently_delete_directory_entry(
                        session,
                        current.id,
                        self.delete_payload(current),
                        actor,
                        request(),
                    )
            self.assertEqual(raised.exception.code, expected_code)
            audit.assert_not_awaited()
            session.delete.assert_not_awaited()

    async def test_permanent_delete_checks_timestamp_and_exact_trimmed_name(self):
        current = entry(is_active=False)
        actor = user(role="superadmin")
        stale = current.updated_at.replace(hour=11)
        cases = (
            (
                self.delete_payload(current, expected_updated_at=stale),
                "directory_entry_stale",
            ),
            (
                self.delete_payload(current, confirmation_name="Different name"),
                "confirmation_name_mismatch",
            ),
        )
        for payload, expected_code in cases:
            session = AsyncMock()
            with (
                patch.object(directory, "get_directory_entry", AsyncMock(return_value=current)),
                patch.object(directory, "record_audit_event", AsyncMock()) as audit,
            ):
                with self.assertRaises(directory.DirectoryPermanentDeleteError) as raised:
                    await directory.permanently_delete_directory_entry(
                        session, current.id, payload, actor, request()
                    )
            self.assertEqual(raised.exception.code, expected_code)
            audit.assert_not_awaited()

        trimmed = self.delete_payload(
            current,
            confirmation_name=f"  {current.display_name}  ",
        )
        self.assertEqual(trimmed.confirmation_name, current.display_name)

    async def test_restore_or_link_after_confirmation_is_reported_as_stale(self):
        actor = user(role="superadmin")
        dialog_timestamp = datetime(2026, 7, 25, 10, 0, tzinfo=timezone.utc)
        changed_timestamp = datetime(2026, 7, 25, 10, 1, tzinfo=timezone.utc)
        for current in (
            entry(is_active=True, updated_at=changed_timestamp),
            entry(
                is_active=False,
                linked_user_id=uuid4(),
                updated_at=changed_timestamp,
            ),
        ):
            session = AsyncMock()
            with (
                patch.object(directory, "get_directory_entry", AsyncMock(return_value=current)),
                patch.object(directory, "record_audit_event", AsyncMock()) as audit,
            ):
                with self.assertRaises(directory.DirectoryPermanentDeleteError) as raised:
                    await directory.permanently_delete_directory_entry(
                        session,
                        current.id,
                        self.delete_payload(
                            current,
                            expected_updated_at=dialog_timestamp,
                        ),
                        actor,
                        request(),
                    )
            self.assertEqual(raised.exception.code, "directory_entry_stale")
            audit.assert_not_awaited()

    async def test_permanent_delete_writes_safe_audit_then_deletes(self):
        current = entry(is_active=False)
        actor = user(role="superadmin")
        session = AsyncMock()
        with (
            patch.object(directory, "get_directory_entry", AsyncMock(return_value=current)) as getter,
            patch.object(directory, "record_audit_event", AsyncMock()) as audit,
        ):
            deleted_id = await directory.permanently_delete_directory_entry(
                session,
                current.id,
                self.delete_payload(current, reason="duplicate"),
                actor,
                request(),
            )
        self.assertEqual(deleted_id, current.id)
        getter.assert_awaited_once_with(
            session,
            current.id,
            include_inactive=True,
            for_update=True,
        )
        session.delete.assert_awaited_once_with(current)
        session.flush.assert_awaited_once()
        audit_details = audit.await_args.kwargs["details"]
        self.assertEqual(
            audit_details,
            {
                "deleted_entry_id": str(current.id),
                "entry_kind": "directory_entry",
                "reason": "duplicate",
                "was_archived": True,
                "had_linked_user": False,
            },
        )
        self.assertIsNone(audit.await_args.kwargs["target_label"])
        serialized = repr(audit.await_args.kwargs)
        for personal_value in (
            current.display_name,
            current.department,
            current.email,
            current.work_phone,
        ):
            self.assertNotIn(personal_value, serialized)

    async def test_permanent_delete_route_commits_once_and_restricts_safely(self):
        current = entry(is_active=False)
        actor = user(role="superadmin")
        payload = self.delete_payload(current)
        session = MutationSession()
        with patch.object(
            directory_routes,
            "permanently_delete_directory_entry",
            AsyncMock(return_value=current.id),
        ):
            response = await directory_routes.post_directory_entry_delete_permanently(
                current.id, payload, request(), session, actor
            )
        self.assertEqual(response.status_code, 204)
        self.assertEqual(session.commits, 1)
        self.assertEqual(session.rollbacks, 0)

        with patch.object(
            directory_routes,
            "permanently_delete_directory_entry",
            AsyncMock(
                side_effect=directory.DirectoryPermanentDeleteError(
                    "directory_entry_not_found"
                )
            ),
        ):
            with self.assertRaises(HTTPException) as raised:
                await directory_routes.post_directory_entry_delete_permanently(
                    current.id, payload, request(), session, actor
                )
        self.assertEqual(raised.exception.status_code, 404)
        self.assertEqual(raised.exception.detail, "directory_entry_not_found")

    async def test_permanent_delete_failure_rolls_back_without_partial_success(self):
        current = entry(is_active=False)
        actor = user(role="superadmin")
        payload = self.delete_payload(current)
        session = MutationSession()
        with patch.object(
            directory_routes,
            "permanently_delete_directory_entry",
            AsyncMock(side_effect=RuntimeError("audit persistence failed")),
        ):
            with self.assertRaises(RuntimeError):
                await directory_routes.post_directory_entry_delete_permanently(
                    current.id, payload, request(), session, actor
                )
        self.assertEqual(session.commits, 0)
        self.assertEqual(session.rollbacks, 1)

        restricted_session = MutationSession()
        with patch.object(
            directory_routes,
            "permanently_delete_directory_entry",
            AsyncMock(
                side_effect=IntegrityError(
                    "DELETE FROM directory_entries",
                    {},
                    RuntimeError("foreign key restriction"),
                )
            ),
        ):
            with self.assertRaises(HTTPException) as restricted:
                await directory_routes.post_directory_entry_delete_permanently(
                    current.id,
                    payload,
                    request(),
                    restricted_session,
                    actor,
                )
        self.assertEqual(restricted.exception.status_code, 409)
        self.assertEqual(
            restricted.exception.detail,
            "directory_entry_delete_restricted",
        )
        self.assertEqual(restricted_session.commits, 0)
        self.assertEqual(restricted_session.rollbacks, 1)

    def test_permanent_delete_schema_rejects_empty_unknown_and_extra_fields(self):
        current = entry(is_active=False)
        base = {
            "confirmation_name": current.display_name,
            "reason": "test_data",
            "expected_updated_at": current.updated_at,
        }
        for invalid in (
            {**base, "confirmation_name": "  "},
            {**base, "reason": "free-form reason"},
            {**base, "unexpected": "value"},
        ):
            with self.assertRaises(ValidationError):
                DirectoryEntryPermanentDelete.model_validate(invalid)


if __name__ == "__main__":
    unittest.main()
