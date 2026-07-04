import asyncio
import logging
import time
from datetime import datetime, timezone
from uuid import UUID

from redis.asyncio import Redis
from redis.exceptions import RedisError
from sqlalchemy import or_, select

from app.core.config import settings
from app.db.session import AsyncSessionLocal
from app.models.direct import DirectConversation
from app.models.discussion import DiscussionMember
from app.models.group import GroupMember
from app.models.user import User

logger = logging.getLogger("uvicorn.error")

_client: Redis | None = None
_offline_tasks: dict[UUID, asyncio.Task[None]] = {}
_sweeper_task: asyncio.Task[None] | None = None
_last_warning_at = 0.0


def _connection_key(user_id: UUID) -> str:
    return f"presence:user:{user_id}:connections"


def _status_key(user_id: UUID) -> str:
    return f"presence:user:{user_id}:status"


def _activity_key(user_id: UUID) -> str:
    return f"presence:user:{user_id}:last_activity"


def _typing_key(room_type: str, room_id: UUID, user_id: UUID) -> str:
    return f"typing:{room_type}:{room_id}:user:{user_id}:connections"


def get_presence_client() -> Redis:
    global _client
    if _client is None:
        _client = Redis.from_url(
            settings.valkey_url,
            decode_responses=True,
            socket_connect_timeout=2,
            socket_timeout=2,
        )
    return _client


def _warn_degraded(operation: str, exc: BaseException) -> None:
    global _last_warning_at
    now = time.monotonic()
    if now - _last_warning_at >= 60:
        logger.warning("Presence temporarily unavailable during %s: %s", operation, exc)
        _last_warning_at = now


async def _active_connection_count(client: Redis, user_id: UUID) -> int:
    now = time.time()
    key = _connection_key(user_id)
    await client.zremrangebyscore(key, 0, now)
    return int(await client.zcard(key))


async def register_connection(user_id: UUID, connection_id: str) -> bool:
    """Register one tab/device and return whether the user transitioned online."""
    task = _offline_tasks.pop(user_id, None)
    if task is not None:
        task.cancel()
    try:
        client = get_presence_client()
        was_online = await _active_connection_count(client, user_id) > 0
        expires_at = time.time() + settings.presence_connection_ttl_seconds
        async with client.pipeline(transaction=True) as pipeline:
            pipeline.zadd(_connection_key(user_id), {connection_id: expires_at})
            pipeline.expire(
                _connection_key(user_id),
                settings.presence_connection_ttl_seconds + settings.presence_offline_grace_seconds + 60,
            )
            pipeline.set(_status_key(user_id), "online")
            pipeline.set(_activity_key(user_id), datetime.now(timezone.utc).isoformat())
            await pipeline.execute()
        if not was_online:
            await broadcast_presence_update(user_id, "online", None)
        return not was_online
    except RedisError as exc:
        _warn_degraded("connect", exc)
        return False


async def refresh_connection(user_id: UUID, connection_id: str) -> None:
    try:
        client = get_presence_client()
        expires_at = time.time() + settings.presence_connection_ttl_seconds
        async with client.pipeline(transaction=True) as pipeline:
            pipeline.zadd(_connection_key(user_id), {connection_id: expires_at})
            pipeline.expire(
                _connection_key(user_id),
                settings.presence_connection_ttl_seconds + settings.presence_offline_grace_seconds + 60,
            )
            pipeline.set(_activity_key(user_id), datetime.now(timezone.utc).isoformat())
            await pipeline.execute()
    except RedisError as exc:
        _warn_degraded("heartbeat", exc)


async def unregister_connection(user_id: UUID, connection_id: str) -> None:
    try:
        client = get_presence_client()
        await client.zrem(_connection_key(user_id), connection_id)
        if await _active_connection_count(client, user_id) == 0:
            schedule_offline_transition(user_id)
    except RedisError as exc:
        _warn_degraded("disconnect", exc)


def schedule_offline_transition(user_id: UUID) -> None:
    existing = _offline_tasks.get(user_id)
    if existing is not None and not existing.done():
        return

    async def transition_after_grace() -> None:
        try:
            await asyncio.sleep(settings.presence_offline_grace_seconds)
            await mark_offline_if_stale(user_id)
        except asyncio.CancelledError:
            return
        finally:
            current_task = asyncio.current_task()
            if _offline_tasks.get(user_id) is current_task:
                _offline_tasks.pop(user_id, None)

    _offline_tasks[user_id] = asyncio.create_task(transition_after_grace())


async def mark_offline_if_stale(user_id: UUID) -> bool:
    try:
        client = get_presence_client()
        if await _active_connection_count(client, user_id) > 0:
            return False
        previous_status = await client.get(_status_key(user_id))
        if previous_status != "online":
            return False
        last_seen_at = datetime.now(timezone.utc)
        async with client.pipeline(transaction=True) as pipeline:
            pipeline.set(_status_key(user_id), "offline")
            pipeline.set(_activity_key(user_id), last_seen_at.isoformat())
            await pipeline.execute()
        async with AsyncSessionLocal() as session:
            user = await session.get(User, user_id)
            if user is not None:
                user.last_seen_at = last_seen_at
                await session.commit()
        await broadcast_presence_update(user_id, "offline", last_seen_at)
        return True
    except RedisError as exc:
        _warn_degraded("offline transition", exc)
        return False
    except Exception as exc:
        _warn_degraded("offline persistence", exc)
        return False


async def get_presence(user: User) -> dict[str, object]:
    try:
        client = get_presence_client()
        online = await _active_connection_count(client, user.id) > 0
        if not online and await client.get(_status_key(user.id)) == "online":
            schedule_offline_transition(user.id)
        return {
            "user_id": user.id,
            "status": "online" if online else "offline",
            "last_seen_at": None if online else user.last_seen_at,
        }
    except RedisError as exc:
        _warn_degraded("snapshot", exc)
        return {"user_id": user.id, "status": "offline", "last_seen_at": user.last_seen_at}


async def visible_presence_user_ids(session, current_user: User, requested_ids: set[UUID]) -> set[UUID]:
    if not requested_ids:
        return set()
    if current_user.role in {"superadmin", "admin"}:
        return requested_ids

    visible = {current_user.id} if current_user.id in requested_ids else set()
    own_group_ids = select(GroupMember.group_id).where(GroupMember.user_id == current_user.id)
    group_result = await session.execute(
        select(GroupMember.user_id).where(
            GroupMember.group_id.in_(own_group_ids), GroupMember.user_id.in_(requested_ids)
        )
    )
    visible.update(group_result.scalars().all())

    direct_result = await session.execute(
        select(DirectConversation.user_one_id, DirectConversation.user_two_id).where(
            or_(
                DirectConversation.user_one_id == current_user.id,
                DirectConversation.user_two_id == current_user.id,
            )
        )
    )
    for user_one_id, user_two_id in direct_result.all():
        other_id = user_two_id if user_one_id == current_user.id else user_one_id
        if other_id in requested_ids:
            visible.add(other_id)

    own_discussion_ids = select(DiscussionMember.discussion_id).where(
        DiscussionMember.user_id == current_user.id
    )
    discussion_result = await session.execute(
        select(DiscussionMember.user_id).where(
            DiscussionMember.discussion_id.in_(own_discussion_ids),
            DiscussionMember.user_id.in_(requested_ids),
        )
    )
    visible.update(discussion_result.scalars().all())
    return visible


async def _presence_viewer_ids(user_id: UUID) -> set[UUID]:
    async with AsyncSessionLocal() as session:
        own_groups = select(GroupMember.group_id).where(GroupMember.user_id == user_id)
        group_result = await session.execute(
            select(GroupMember.user_id).join(User, User.id == GroupMember.user_id).where(
                GroupMember.group_id.in_(own_groups), User.is_active.is_(True)
            )
        )
        viewers = set(group_result.scalars().all())

        direct_result = await session.execute(
            select(DirectConversation.user_one_id, DirectConversation.user_two_id).where(
                or_(DirectConversation.user_one_id == user_id, DirectConversation.user_two_id == user_id)
            )
        )
        for first, second in direct_result.all():
            viewers.update((first, second))

        own_discussions = select(DiscussionMember.discussion_id).where(DiscussionMember.user_id == user_id)
        discussion_result = await session.execute(
            select(DiscussionMember.user_id).join(User, User.id == DiscussionMember.user_id).where(
                DiscussionMember.discussion_id.in_(own_discussions), User.is_active.is_(True)
            )
        )
        viewers.update(discussion_result.scalars().all())
        admin_result = await session.execute(
            select(User.id).where(User.role.in_(("superadmin", "admin")), User.is_active.is_(True))
        )
        viewers.update(admin_result.scalars().all())
        return viewers


async def broadcast_presence_update(
    user_id: UUID, status: str, last_seen_at: datetime | None
) -> None:
    from app.services.websocket_manager import user_websocket_manager

    event = {
        "type": "presence.updated",
        "user_id": str(user_id),
        "status": status,
        "last_seen_at": last_seen_at.isoformat() if last_seen_at else None,
    }
    try:
        for viewer_id in await _presence_viewer_ids(user_id):
            await user_websocket_manager.broadcast_to_user(viewer_id, event)
    except Exception as exc:
        _warn_degraded("presence broadcast", exc)


async def update_typing(
    room_type: str,
    room_id: UUID,
    user_id: UUID,
    connection_id: str,
    is_typing: bool,
) -> tuple[bool, bool]:
    """Return (state_changed, aggregate_is_typing) for one room user."""
    try:
        client = get_presence_client()
        key = _typing_key(room_type, room_id, user_id)
        now = time.time()
        await client.zremrangebyscore(key, 0, now)
        was_typing = int(await client.zcard(key)) > 0
        if is_typing:
            await client.zadd(key, {connection_id: now + settings.typing_ttl_seconds})
            await client.expire(key, settings.typing_ttl_seconds * 3)
        else:
            await client.zrem(key, connection_id)
        is_now_typing = int(await client.zcard(key)) > 0
        return was_typing != is_now_typing, is_now_typing
    except RedisError as exc:
        _warn_degraded("typing", exc)
        return False, False


async def _presence_sweeper() -> None:
    while True:
        try:
            client = get_presence_client()
            async for key in client.scan_iter(match="presence:user:*:status", count=100):
                if await client.get(key) != "online":
                    continue
                user_id_text = key.split(":")[2]
                try:
                    user_id = UUID(user_id_text)
                except ValueError:
                    continue
                if await _active_connection_count(client, user_id) == 0:
                    schedule_offline_transition(user_id)
        except RedisError as exc:
            _warn_degraded("sweeper", exc)
        await asyncio.sleep(max(5, settings.presence_offline_grace_seconds))


def start_presence_sweeper() -> None:
    global _sweeper_task
    if _sweeper_task is None or _sweeper_task.done():
        _sweeper_task = asyncio.create_task(_presence_sweeper())


async def stop_presence_service() -> None:
    global _client, _sweeper_task
    if _sweeper_task is not None:
        _sweeper_task.cancel()
        try:
            await _sweeper_task
        except asyncio.CancelledError:
            pass
        _sweeper_task = None
    for task in _offline_tasks.values():
        task.cancel()
    _offline_tasks.clear()
    if _client is not None:
        await _client.aclose()
        _client = None
