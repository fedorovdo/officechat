import unittest
from types import SimpleNamespace
from uuid import uuid4

from app.services.notifications import build_dedupe_key, preferences_allow, sanitize_metadata, sanitize_preview


class NotificationServiceTests(unittest.TestCase):
    def test_default_preferences_keep_group_messages_quiet(self):
        preferences = SimpleNamespace(group_messages_enabled=False, mentions_enabled=True, system_enabled=False)

        self.assertFalse(preferences_allow(preferences, "group_message"))
        self.assertTrue(preferences_allow(preferences, "mention"))
        self.assertTrue(preferences_allow(preferences, "system"))

    def test_reaction_dedupe_includes_actor_and_emoji(self):
        recipient = uuid4()
        message = uuid4()
        first_actor = uuid4()
        second_actor = uuid4()

        first = build_dedupe_key(recipient, "reaction", "reaction", message, {"emoji": "👍", "actor_user_id": first_actor})
        duplicate = build_dedupe_key(recipient, "reaction", "reaction", message, {"emoji": "👍", "actor_user_id": first_actor})
        other_actor = build_dedupe_key(recipient, "reaction", "reaction", message, {"emoji": "👍", "actor_user_id": second_actor})

        self.assertEqual(first, duplicate)
        self.assertNotEqual(first, other_actor)

    def test_preview_and_metadata_are_sanitized(self):
        group_id = uuid4()
        self.assertEqual(sanitize_preview(" hello\n\nworld "), "hello world")
        self.assertTrue((sanitize_preview("x" * 220) or "").endswith("..."))
        self.assertEqual(
            sanitize_metadata({"group_id": group_id, "filesystem_path": "/data/uploads/private.txt"}),
            {"group_id": str(group_id)},
        )


if __name__ == "__main__":
    unittest.main()
