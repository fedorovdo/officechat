from redis.asyncio import Redis

from app.core.config import settings


async def check_valkey_connection() -> None:
    client = Redis.from_url(settings.valkey_url, socket_connect_timeout=3, socket_timeout=3)
    try:
        await client.ping()
    finally:
        await client.aclose()
