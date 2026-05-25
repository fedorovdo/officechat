import asyncpg

from app.core.config import settings


async def check_postgres_connection() -> None:
    connection = await asyncpg.connect(settings.database_url, timeout=3)
    try:
        await connection.execute("SELECT 1")
    finally:
        await connection.close()
