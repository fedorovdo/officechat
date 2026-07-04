import asyncio
import time
import unittest
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch
from uuid import uuid4

from app.core.config import Settings
from app.services import presence


class FakePipeline:
    def __init__(self, client):
        self.client = client
        self.commands = []

    async def __aenter__(self):
        return self

    async def __aexit__(self, *_):
        return None

    def zadd(self, *args):
        self.commands.append(("zadd", args))

    def expire(self, *args):
        self.commands.append(("expire", args))

    def set(self, *args):
        self.commands.append(("set", args))

    async def execute(self):
        for method, args in self.commands:
            await getattr(self.client, method)(*args)


class FakeRedis:
    def __init__(self):
        self.zsets = {}
        self.values = {}

    def pipeline(self, transaction=True):
        return FakePipeline(self)

    async def zadd(self, key, values):
        self.zsets.setdefault(key, {}).update(values)

    async def zremrangebyscore(self, key, minimum, maximum):
        values = self.zsets.setdefault(key, {})
        for member, score in list(values.items()):
            if minimum <= score <= maximum:
                values.pop(member)

    async def zcard(self, key):
        return len(self.zsets.get(key, {}))

    async def zrem(self, key, member):
        self.zsets.setdefault(key, {}).pop(member, None)

    async def expire(self, key, seconds):
        return True

    async def set(self, key, value):
        self.values[key] = value

    async def get(self, key):
        return self.values.get(key)


class FakeSession:
    def __init__(self, user):
        self.user = user
        self.committed = False

    async def __aenter__(self):
        return self

    async def __aexit__(self, *_):
        return None

    async def get(self, model, user_id):
        return self.user

    async def commit(self):
        self.committed = True


class PresenceTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.redis = FakeRedis()
        self.client_patch = patch("app.services.presence.get_presence_client", return_value=self.redis)
        self.client_patch.start()
        self.broadcast_patch = patch(
            "app.services.presence.broadcast_presence_update", new=AsyncMock()
        )
        self.broadcast = self.broadcast_patch.start()

    async def asyncTearDown(self):
        for task in list(presence._offline_tasks.values()):
            task.cancel()
        presence._offline_tasks.clear()
        self.broadcast_patch.stop()
        self.client_patch.stop()

    async def test_multiple_connections_keep_user_online(self):
        user_id = uuid4()
        await presence.register_connection(user_id, "tab-one")
        await presence.register_connection(user_id, "tab-two")
        await presence.unregister_connection(user_id, "tab-one")

        self.assertEqual(await self.redis.zcard(presence._connection_key(user_id)), 1)
        self.assertNotIn(user_id, presence._offline_tasks)
        self.broadcast.assert_awaited_once()

    async def test_final_disconnect_schedules_grace_transition(self):
        user_id = uuid4()
        await presence.register_connection(user_id, "tab-one")
        await presence.unregister_connection(user_id, "tab-one")

        self.assertIn(user_id, presence._offline_tasks)

    async def test_offline_transition_persists_last_seen_once(self):
        user_id = uuid4()
        user = SimpleNamespace(id=user_id, last_seen_at=None)
        session = FakeSession(user)
        self.redis.values[presence._status_key(user_id)] = "online"

        with patch("app.services.presence.AsyncSessionLocal", return_value=session):
            changed = await presence.mark_offline_if_stale(user_id)

        self.assertTrue(changed)
        self.assertIsNotNone(user.last_seen_at)
        self.assertTrue(session.committed)
        self.assertEqual(self.redis.values[presence._status_key(user_id)], "offline")

    async def test_reconnect_cancels_pending_offline_transition(self):
        user_id = uuid4()
        await presence.register_connection(user_id, "tab-one")
        await presence.unregister_connection(user_id, "tab-one")
        pending_task = presence._offline_tasks[user_id]
        await presence.register_connection(user_id, "tab-two")
        await asyncio.sleep(0)

        self.assertTrue(pending_task.cancelled() or pending_task.done())
        self.assertNotIn(user_id, presence._offline_tasks)

    async def test_typing_is_deduplicated_by_user_across_tabs(self):
        room_id = uuid4()
        user_id = uuid4()
        changed, active = await presence.update_typing("group", room_id, user_id, "tab-one", True)
        self.assertEqual((changed, active), (True, True))
        changed, active = await presence.update_typing("group", room_id, user_id, "tab-two", True)
        self.assertEqual((changed, active), (False, True))
        changed, active = await presence.update_typing("group", room_id, user_id, "tab-one", False)
        self.assertEqual((changed, active), (False, True))
        changed, active = await presence.update_typing("group", room_id, user_id, "tab-two", False)
        self.assertEqual((changed, active), (True, False))

    async def test_stale_typing_connection_expires(self):
        room_id = uuid4()
        user_id = uuid4()
        key = presence._typing_key("direct", room_id, user_id)
        self.redis.zsets[key] = {"stale-tab": time.time() - 1}

        changed, active = await presence.update_typing("direct", room_id, user_id, "stale-tab", False)
        self.assertFalse(active)
        self.assertFalse(changed)


class PresenceConfigurationTests(unittest.TestCase):
    def test_presence_intervals_are_validated(self):
        with self.assertRaises(ValueError):
            Settings(presence_connection_ttl_seconds=5)
        with self.assertRaises(ValueError):
            Settings(typing_ttl_seconds=1)
        with self.assertRaises(ValueError):
            Settings(presence_connection_ttl_seconds=30, presence_heartbeat_seconds=30)


if __name__ == "__main__":
    unittest.main()
