import asyncpg

from app.core.config import settings


async def check_postgres_connection() -> None:
    connection = await asyncpg.connect(settings.database_url, timeout=3)
    try:
        await connection.execute("SELECT 1")
    finally:
        await connection.close()


async def get_alembic_revision() -> str | None:
    connection = await asyncpg.connect(settings.database_url, timeout=3)
    try:
        row = await connection.fetchrow("SELECT version_num FROM alembic_version LIMIT 1")
        return row["version_num"] if row else None
    finally:
        await connection.close()
