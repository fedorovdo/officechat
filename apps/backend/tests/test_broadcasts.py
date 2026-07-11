import unittest
import uuid
from datetime import datetime, timezone
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

from app.schemas.broadcast import BroadcastAudiencePayload
from app.services.broadcasts import (
    BroadcastConflictError,
    BroadcastError,
    ensure_sender,
    normalize_audience,
    serialize_broadcast_public,
    sign_preview_token,
    verify_preview_token,
)
from app.api.routes import broadcasts as broadcast_routes


class BroadcastServiceTests(unittest.TestCase):
    def test_normalize_all_active_users_ignores_selected_ids(self):
        payload = BroadcastAudiencePayload(
            audience_type="all_active_users",
            group_ids=[uuid.uuid4()],
            user_ids=[uuid.uuid4()],
        )

        self.assertEqual(normalize_audience(payload), {"group_ids": [], "user_ids": []})

    def test_normalize_selected_groups_requires_group(self):
        payload = BroadcastAudiencePayload(audience_type="selected_groups")

        with self.assertRaises(BroadcastError):
            normalize_audience(payload)

    def test_normalize_selected_users_sorts_and_deduplicates(self):
        first = uuid.uuid4()
        second = uuid.uuid4()
        payload = BroadcastAudiencePayload(
            audience_type="selected_users",
            user_ids=[second, first, second],
        )

        normalized = normalize_audience(payload)

        self.assertEqual(normalized["group_ids"], [])
        self.assertEqual(normalized["user_ids"], sorted({str(first), str(second)}))

    def test_preview_token_validates_actor_and_audience(self):
        actor_id = uuid.uuid4()
        audience = {"group_ids": [str(uuid.uuid4())], "user_ids": []}
        token, digest, _ = sign_preview_token(actor_id, "selected_groups", audience)

        verify_preview_token(token, actor_id, "selected_groups", digest)
        with self.assertRaises(BroadcastConflictError):
            verify_preview_token(token, uuid.uuid4(), "selected_groups", digest)
        with self.assertRaises(BroadcastConflictError):
            verify_preview_token(token, actor_id, "selected_groups", "changed")

    def test_bot_sender_is_denied_even_if_permission_was_granted_elsewhere(self):
        sender = SimpleNamespace(is_active=True, role="bot", auth_provider="bot")

        with self.assertRaises(PermissionError):
            ensure_sender(sender)

    def test_serialize_broadcast_public_materializes_timestamp_fields(self):
        created_at = datetime(2026, 7, 11, 10, 0, tzinfo=timezone.utc)
        updated_at = datetime(2026, 7, 11, 10, 1, tzinfo=timezone.utc)
        announcement = SimpleNamespace(
            id=uuid.uuid4(),
            created_by_user_id=uuid.uuid4(),
            created_by_username="admin",
            created_by_display_name="Admin",
            title="Maintenance",
            body="Tonight",
            priority="normal",
            status="sent",
            audience_type="selected_users",
            audience_definition={"user_ids": [str(uuid.uuid4())], "group_ids": []},
            recipient_count=1,
            notified_count=1,
            read_count=0,
            failed_count=0,
            sent_at=created_at,
            expires_at=None,
            retracted_at=None,
            created_at=created_at,
            updated_at=updated_at,
        )

        public = serialize_broadcast_public(announcement)

        self.assertEqual(public.created_at, created_at)
        self.assertEqual(public.updated_at, updated_at)
        self.assertEqual(public.title, "Maintenance")


class FakeSession:
    def __init__(self, announcement):
        self.announcement = announcement
        self.commits = 0
        self.rollbacks = 0

    async def get(self, model, item_id):
        return self.announcement if item_id == self.announcement.id else None

    async def commit(self):
        self.commits += 1

    async def rollback(self):
        self.rollbacks += 1


class BroadcastRouteTests(unittest.IsolatedAsyncioTestCase):
    def announcement(self):
        created_at = datetime(2026, 7, 11, 10, 0, tzinfo=timezone.utc)
        return SimpleNamespace(
            id=uuid.uuid4(),
            created_by_user_id=uuid.uuid4(),
            created_by_username="admin",
            created_by_display_name="Admin",
            title="Maintenance",
            body="Tonight",
            priority="normal",
            status="draft",
            audience_type="selected_users",
            audience_definition={"user_ids": [str(uuid.uuid4())], "group_ids": []},
            recipient_count=0,
            notified_count=0,
            read_count=0,
            failed_count=0,
            sent_at=None,
            expires_at=None,
            retracted_at=None,
            created_at=created_at,
            updated_at=created_at,
        )

    async def test_send_returns_snapshot_even_when_websocket_delivery_fails(self):
        announcement = self.announcement()
        session = FakeSession(announcement)
        actor = SimpleNamespace(id=announcement.created_by_user_id, role="user")
        response = serialize_broadcast_public(announcement)
        response.status = "sent"
        request = SimpleNamespace(client=None, state=SimpleNamespace(request_id="request-1"))
        payload = SimpleNamespace()

        with (
            patch.object(broadcast_routes, "send_broadcast", AsyncMock(return_value=(announcement, [uuid.uuid4()]))),
            patch.object(broadcast_routes, "load_broadcast_public", AsyncMock(return_value=response)),
            patch.object(
                broadcast_routes,
                "broadcast_created_events_from_payload",
                AsyncMock(side_effect=RuntimeError("websocket failed")),
            ),
        ):
            returned = await broadcast_routes.post_broadcast_send(
                announcement.id,
                payload,
                request,
                session,
                actor,
            )

        self.assertEqual(returned.status, "sent")
        self.assertEqual(session.commits, 1)
        self.assertEqual(session.rollbacks, 0)
