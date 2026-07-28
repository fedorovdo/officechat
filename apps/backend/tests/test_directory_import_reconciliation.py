import unittest
from datetime import UTC, datetime
from types import SimpleNamespace
from uuid import uuid4

from pydantic import ValidationError

from app.models.directory import DirectoryEntry
from app.schemas.directory_import import DirectoryImportMatchUpdate
from app.services.directory import (
    canonical_text,
    normalize_department,
    normalize_display_name,
    normalize_email,
    normalize_phone_digits,
    normalize_position,
)
from app.services.directory_import_reconciliation import (
    MATCHED_KINDS,
    _default_update_fields,
    _duplicate_keys,
    _has_import_value,
    _validate_directory_import_rows,
    classify_directory_match,
    find_directory_match_candidates,
    score_directory_match,
)


def entry(**overrides):
    values = {
        "id": uuid4(),
        "display_name": "Dmitrii Fedorov",
        "department": "IT",
        "position": "Engineer",
        "internal_phone": "401",
        "work_phone": "+7 (495) 123-45-67",
        "mobile_phone": None,
        "email": "dmitrii@example.test",
        "room": "401",
        "location": "HQ",
        "notes": None,
        "linked_user_id": None,
        "is_active": True,
        "created_by_user_id": None,
        "updated_by_user_id": None,
        "created_at": datetime.now(UTC),
        "updated_at": datetime.now(UTC),
    }
    values.update(overrides)
    return DirectoryEntry(**values)


class DirectoryImportNormalizationTests(unittest.TestCase):
    def test_central_normalization_is_consistent(self):
        self.assertEqual(normalize_phone_digits("+7 (495) 123-45-67"), "74951234567")
        self.assertEqual(normalize_email("  USER@Example.COM "), "user@example.com")
        self.assertEqual(normalize_display_name("  Дмитрий   Ф. "), "дмитрий ф")
        self.assertEqual(normalize_department(" IT / Support "), "it support")
        self.assertEqual(normalize_position("Senior-Engineer"), "senior engineer")
        self.assertEqual(canonical_text("  Room № 401 "), "room no 401")


class DirectoryImportMatchingTests(unittest.TestCase):
    def test_exact_personal_email_is_strong(self):
        candidate = score_directory_match(
            {"display_name": "Other Name", "email": "DMITRII@example.test"},
            entry(),
        )
        self.assertIsNotNone(candidate)
        self.assertEqual(candidate.score, 100)
        self.assertIn("exact_email", {item["code"] for item in candidate.reasons})

    def test_shared_mailbox_does_not_select_a_person(self):
        candidate = score_directory_match(
            {"display_name": "Other Name", "email": "info@example.test"},
            entry(email="info@example.test"),
        )
        self.assertIsNone(candidate)

    def test_long_normalized_phone_and_name_are_exact(self):
        candidate = score_directory_match(
            {
                "display_name": "Dmitrii Fedorov",
                "work_phone": "7 495 123 45 67",
            },
            entry(),
        )
        self.assertEqual(candidate.score, 100)
        self.assertIn("exact_long_phone", {item["code"] for item in candidate.reasons})

    def test_shared_phone_with_conflicting_department_is_not_exact(self):
        candidate = score_directory_match(
            {
                "display_name": "Dmitrii Fedorov",
                "department": "Finance",
                "work_phone": "7 495 123 45 67",
            },
            entry(department="IT"),
        )
        self.assertIsNotNone(candidate)
        self.assertLess(candidate.score, 90)
        self.assertIn(
            "department_conflict",
            {item["code"] for item in candidate.reasons},
        )

    def test_short_extension_alone_is_not_a_match(self):
        candidate = score_directory_match({"internal_phone": "401"}, entry())
        self.assertIsNone(candidate)

    def test_name_department_position_is_exact_and_name_department_is_probable(self):
        exact = score_directory_match(
            {
                "display_name": "Dmitrii Fedorov",
                "department": "IT",
                "position": "Engineer",
            },
            entry(),
        )
        probable = score_directory_match(
            {"display_name": "Dmitrii Fedorov", "department": "IT"},
            entry(),
        )
        self.assertEqual(exact.score, 100)
        self.assertEqual(probable.score, 75)

    def test_conflicting_email_and_phone_never_produce_exact_candidate(self):
        email_entry = entry(
            id=uuid4(),
            display_name="Email Person",
            work_phone="+7 111 111-11-11",
        )
        phone_entry = entry(
            id=uuid4(),
            display_name="Phone Person",
            email="phone@example.test",
        )
        candidates = find_directory_match_candidates(
            {
                "display_name": "Unrelated",
                "email": "dmitrii@example.test",
                "work_phone": "+7 495 123-45-67",
            },
            [email_entry, phone_entry],
        )
        self.assertEqual(len(candidates), 2)
        self.assertTrue(all(item.score <= 65 for item in candidates))
        self.assertTrue(
            all(
                "identifier_conflict" in {reason["code"] for reason in item.reasons}
                for item in candidates
            )
        )

    def test_probable_ambiguous_and_archived_classification(self):
        probable = find_directory_match_candidates(
            {"display_name": "Dmitrii Fedorov", "department": "IT"},
            [entry()],
        )
        ambiguous = find_directory_match_candidates(
            {"display_name": "Common Name"},
            [
                entry(display_name="Common Name", email=None, work_phone=None),
                entry(display_name="Common Name", email=None, work_phone=None),
            ],
        )
        archived = find_directory_match_candidates(
            {"email": "dmitrii@example.test"},
            [entry(is_active=False)],
        )
        self.assertEqual(classify_directory_match(probable), "probable")
        self.assertEqual(classify_directory_match(ambiguous), "ambiguous")
        self.assertEqual(classify_directory_match(archived), "archived_match")

    def test_intra_batch_duplicate_keys_cover_email_phone_identity_and_full_row(self):
        first = SimpleNamespace(
            normalized_data={
                "display_name": "Dmitrii Fedorov",
                "department": "IT",
                "position": "Engineer",
                "email": "dmitrii@example.test",
                "work_phone": "+7 495 123-45-67",
            }
        )
        second = SimpleNamespace(
            normalized_data={
                "display_name": "  dmitrii fedorov ",
                "department": "it",
                "position": "ENGINEER",
                "email": "DMITRII@example.test",
                "work_phone": "74951234567",
            }
        )
        self.assertTrue(_duplicate_keys(first) & _duplicate_keys(second))

    def test_shared_mailbox_and_shared_phone_do_not_merge_different_people(self):
        first = SimpleNamespace(
            normalized_data={
                "display_name": "Person One",
                "department": "IT",
                "email": "info@example.test",
                "work_phone": "+7 495 123-45-67",
            }
        )
        second = SimpleNamespace(
            normalized_data={
                "display_name": "Person Two",
                "department": "Finance",
                "email": "INFO@example.test",
                "work_phone": "+7 495 123-45-67",
            }
        )
        self.assertFalse(_duplicate_keys(first) & _duplicate_keys(second))

    def test_default_update_fields_never_include_blank_values_or_linked_user(self):
        row = SimpleNamespace(
            normalized_data={
                "display_name": "Dmitrii Fedorov",
                "department": "",
                "position": "Lead Engineer",
                "linked_user_id": str(uuid4()),
            }
        )
        fields = _default_update_fields(row, entry())
        self.assertEqual(fields, ["position"])
        self.assertNotIn("linked_user_id", fields)

    def test_whitespace_values_are_blank_for_every_importable_field(self):
        for field in (
            "display_name",
            "department",
            "position",
            "internal_phone",
            "work_phone",
            "mobile_phone",
            "email",
            "room",
            "location",
            "notes",
        ):
            with self.subTest(field=field):
                self.assertFalse(_has_import_value(" \t\n"))
                row = SimpleNamespace(normalized_data={field: " \t\n"})
                self.assertNotIn(field, _default_update_fields(row, entry()))

    def test_exact_match_cannot_be_forced_to_create(self):
        existing = entry()
        row = SimpleNamespace(
            id=uuid4(),
            proposed_action="create",
            is_selected=True,
            detected_kind="person",
            warnings=[],
            normalized_data={
                "display_name": existing.display_name,
                "email": existing.email,
            },
            match_status="exact",
            matched_entry_id=None,
            update_fields=[],
            restore_if_archived=False,
            expected_entry_updated_at=None,
        )
        batch = SimpleNamespace(status="reconciled")
        validation = _validate_directory_import_rows(batch, [row], [existing])
        self.assertFalse(validation.can_execute)
        self.assertEqual(validation.stale_count, 1)
        self.assertIn(
            "stale_directory_snapshot",
            {item["code"] for item in validation.blocking_reasons},
        )

    def test_restore_count_is_disjoint_from_update_count(self):
        archived = entry(is_active=False)
        row = SimpleNamespace(
            id=uuid4(),
            proposed_action="update",
            is_selected=True,
            detected_kind="person",
            warnings=[],
            normalized_data={"position": "Lead Engineer"},
            match_status="archived_match",
            matched_entry_id=archived.id,
            update_fields=["position"],
            restore_if_archived=True,
            expected_entry_updated_at=archived.updated_at,
        )
        batch = SimpleNamespace(status="reconciled")
        validation = _validate_directory_import_rows(batch, [row], [archived])
        self.assertTrue(validation.can_execute)
        self.assertEqual(validation.restore_count, 1)
        self.assertEqual(validation.update_count, 0)

    def test_shared_role_and_department_contact_do_not_auto_match_people(self):
        self.assertNotIn("role", MATCHED_KINDS)
        self.assertNotIn("department_contact", MATCHED_KINDS)


class DirectoryImportActionSchemaTests(unittest.TestCase):
    def test_update_requires_candidate_and_field(self):
        with self.assertRaises(ValidationError):
            DirectoryImportMatchUpdate(
                proposed_action="update",
                matched_entry_id=None,
                update_fields=["position"],
                version=1,
            )
        with self.assertRaises(ValidationError):
            DirectoryImportMatchUpdate(
                proposed_action="update",
                matched_entry_id=uuid4(),
                update_fields=[],
                version=1,
            )

    def test_update_field_allowlist_and_mass_assignment(self):
        with self.assertRaises(ValidationError):
            DirectoryImportMatchUpdate(
                proposed_action="update",
                matched_entry_id=uuid4(),
                update_fields=["linked_user_id"],
                version=1,
            )
        with self.assertRaises(ValidationError):
            DirectoryImportMatchUpdate.model_validate(
                {
                    "proposed_action": "skip",
                    "version": 1,
                    "execution_status": "completed",
                }
            )

    def test_create_and_skip_reject_match_side_effects(self):
        with self.assertRaises(ValidationError):
            DirectoryImportMatchUpdate(
                proposed_action="create",
                matched_entry_id=uuid4(),
                version=1,
            )


if __name__ == "__main__":
    unittest.main()
