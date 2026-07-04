import unittest
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch
from uuid import uuid4

from sqlalchemy import func
from sqlalchemy.dialects import postgresql

from app.services import message_search
from app.services.message_search import MessageSearchFilters

NOW = datetime.now(timezone.utc)


def compiled(statement) -> tuple[str, dict[str, object]]:
    value = statement.compile(dialect=postgresql.dialect())
    return str(value), value.params


class ScalarResult:
    def __init__(self, value):
        self.value = value

    def scalar_one_or_none(self):
        return self.value


class ScalarsResult:
    def __init__(self, values):
        self.values = values

    def scalars(self):
        return SimpleNamespace(all=lambda: self.values)


class ContextSession:
    def __init__(self, target, before, after):
        self.results = [ScalarResult(target), ScalarsResult(before), ScalarsResult(after)]
        self.statements = []

    async def execute(self, statement):
        self.statements.append(statement)
        return self.results.pop(0)


class SearchSqlTests(unittest.TestCase):
    def setUp(self):
        self.user = SimpleNamespace(id=uuid4(), role="user", is_active=True)
        self.filters = MessageSearchFilters(query="alert")
        self.ts_query = func.plainto_tsquery("simple", "alert")

    def test_group_search_requires_membership_and_hides_deleted_archived(self):
        sql, _ = compiled(
            message_search._group_search(self.filters, self.user, self.ts_query, "%alert%")
        )
        self.assertIn("group_members", sql)
        self.assertIn("messages.is_deleted IS false", sql)
        self.assertIn("messages.is_archived IS false", sql)
        self.assertNotIn("superadmin", sql)

    def test_direct_search_requires_conversation_participant(self):
        sql, _ = compiled(
            message_search._direct_search(self.filters, self.user, self.ts_query, "%alert%")
        )
        self.assertIn("direct_conversations.user_one_id", sql)
        self.assertIn("direct_conversations.user_two_id", sql)
        self.assertIn("direct_messages.is_deleted IS false", sql)
        self.assertIn("direct_messages.is_archived IS false", sql)

    def test_discussion_search_requires_membership(self):
        sql, _ = compiled(
            message_search._discussion_search(self.filters, self.user, self.ts_query, "%alert%")
        )
        self.assertIn("discussion_members", sql)
        self.assertIn("discussion_messages.is_deleted IS false", sql)
        self.assertIn("discussion_messages.is_archived IS false", sql)

    def test_attachment_sender_date_and_chat_filters_are_in_one_query(self):
        chat_id, sender_id = uuid4(), uuid4()
        filters = MessageSearchFilters(
            query="report",
            chat_id=chat_id,
            sender_id=sender_id,
            date_from=NOW - timedelta(days=2),
            date_to=NOW,
            has_attachment=True,
        )
        sql, params = compiled(
            message_search._group_search(filters, self.user, self.ts_query, "%report%")
        )
        self.assertIn("message_attachments.original_filename", sql)
        self.assertIn("messages.sender_user_id", sql)
        self.assertIn("messages.created_at >=", sql)
        self.assertIn("messages.created_at <=", sql)
        self.assertIn(chat_id, params.values())
        self.assertIn(sender_id, params.values())

    def test_search_uses_simple_full_text_configuration(self):
        sql, params = compiled(
            message_search._group_search(self.filters, self.user, self.ts_query, "%alert%")
        )
        self.assertIn("to_tsvector", sql)
        self.assertIn("plainto_tsquery", sql)
        self.assertIn("simple", params.values())


class SearchHelperTests(unittest.TestCase):
    def test_unicode_excerpt_keeps_match_context_bounded(self):
        body = "начало " * 40 + "авария на сервере" + " конец" * 40
        excerpt = message_search.make_excerpt(body, "авария")
        self.assertIn("авария", excerpt)
        self.assertLessEqual(len(excerpt), 226)

    def test_cursor_round_trip_is_deterministic(self):
        message_id = uuid4()
        cursor = message_search._encode_cursor(2.5, NOW, message_id)
        rank, created_at, decoded_id = message_search._decode_cursor(cursor)
        self.assertEqual((rank, created_at, decoded_id), (2.5, NOW, message_id))
        with self.assertRaises(ValueError):
            message_search._decode_cursor("not-a-cursor")


class MessageContextTests(unittest.IsolatedAsyncioTestCase):
    async def test_context_includes_target_in_normal_order(self):
        chat_id = uuid4()
        older = SimpleNamespace(id=uuid4(), created_at=NOW - timedelta(minutes=1))
        target = SimpleNamespace(id=uuid4(), created_at=NOW)
        newer = SimpleNamespace(id=uuid4(), created_at=NOW + timedelta(minutes=1))
        session = ContextSession(target, [older], [newer])
        with patch("app.services.message_search.ensure_search_chat_access", AsyncMock()):
            result = await message_search.get_message_context(
                session,
                SimpleNamespace(id=uuid4()),
                "group",
                chat_id,
                target.id,
                20,
                20,
            )
        self.assertEqual([row.id for row in result.messages], [older.id, target.id, newer.id])
        self.assertFalse(result.has_more_before)
        self.assertFalse(result.has_more_after)

    async def test_context_access_failure_does_not_query_messages(self):
        session = AsyncMock()
        with patch(
            "app.services.message_search.ensure_search_chat_access",
            AsyncMock(side_effect=PermissionError("denied")),
        ):
            with self.assertRaises(PermissionError):
                await message_search.get_message_context(
                    session,
                    SimpleNamespace(id=uuid4()),
                    "direct",
                    uuid4(),
                    uuid4(),
                    20,
                    20,
                )
        session.execute.assert_not_awaited()


class SearchAccessTests(unittest.IsolatedAsyncioTestCase):
    async def test_admin_role_does_not_bypass_direct_participation(self):
        user = SimpleNamespace(id=uuid4(), role="admin", is_active=True)
        conversation = SimpleNamespace(user_one_id=uuid4(), user_two_id=uuid4())
        with patch(
            "app.services.message_search.get_direct_conversation",
            AsyncMock(return_value=conversation),
        ):
            with self.assertRaises(PermissionError):
                await message_search.ensure_search_chat_access(
                    AsyncMock(), user, "direct", uuid4()
                )

    async def test_group_non_member_is_denied_even_when_group_exists(self):
        user = SimpleNamespace(id=uuid4(), role="admin", is_active=True)
        with (
            patch(
                "app.services.message_search.get_group",
                AsyncMock(return_value=SimpleNamespace(is_active=True)),
            ),
            patch(
                "app.services.message_search.get_group_membership",
                AsyncMock(return_value=None),
            ),
        ):
            with self.assertRaises(PermissionError):
                await message_search.ensure_search_chat_access(
                    AsyncMock(), user, "group", uuid4()
                )


if __name__ == "__main__":
    unittest.main()
