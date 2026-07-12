import unittest
from datetime import datetime, timezone
from types import SimpleNamespace
from uuid import uuid4

from app.core.permissions import CAN_MANAGE_CALENDAR, PERMISSION_CATALOG
from app.schemas.calendar import CalendarEventCreate
from app.services.calendar_events import (
    CalendarError,
    normalize_event_time,
    normalize_reminders,
    validate_conference_url,
    validate_timezone,
)
from app.services.notifications import preferences_allow


class CalendarFoundationTests(unittest.TestCase):
    def test_calendar_permission_is_cataloged(self):
        self.assertIn(CAN_MANAGE_CALENDAR, PERMISSION_CATALOG)
        self.assertEqual(PERMISSION_CATALOG[CAN_MANAGE_CALENDAR]["category"], "calendar")

    def test_timezone_validation_requires_iana_name(self):
        self.assertEqual(validate_timezone("Europe/Moscow"), "Europe/Moscow")
        with self.assertRaises(CalendarError):
            validate_timezone("+03:00")

    def test_unsafe_conference_urls_are_rejected(self):
        self.assertEqual(validate_conference_url("https://meet.example.test/room"), "https://meet.example.test/room")
        with self.assertRaises(CalendarError):
            validate_conference_url("javascript:alert(1)")

    def test_timed_events_are_normalized_to_utc(self):
        payload = CalendarEventCreate(
            title="Planning",
            event_type="meeting",
            starts_at=datetime(2026, 7, 15, 10, 0, tzinfo=timezone.utc),
            ends_at=datetime(2026, 7, 15, 11, 0, tzinfo=timezone.utc),
            timezone="Europe/Moscow",
            audience_type="selected_users",
            user_ids=[uuid4()],
        )
        fields = normalize_event_time(payload)
        self.assertFalse(fields["is_all_day"])
        self.assertEqual(fields["starts_at"].tzinfo, timezone.utc)

    def test_all_day_events_use_dates(self):
        payload = CalendarEventCreate(
            title="Conference",
            event_type="office_event",
            is_all_day=True,
            all_day_start_date="2026-07-15",
            all_day_end_date="2026-07-16",
            timezone="Europe/Moscow",
            audience_type="all_active_users",
        )
        fields = normalize_event_time(payload)
        self.assertTrue(fields["is_all_day"])
        self.assertIsNone(fields["starts_at"])

    def test_reminders_and_preferences_are_separate_from_chat_unread(self):
        self.assertEqual(normalize_reminders([15, 15, 60]), [60, 15])
        preferences = SimpleNamespace(calendar_events_enabled=True, calendar_reminders_enabled=True, calendar_changes_enabled=True)
        self.assertTrue(preferences_allow(preferences, "calendar_created"))
        self.assertTrue(preferences_allow(preferences, "calendar_reminder"))


if __name__ == "__main__":
    unittest.main()
