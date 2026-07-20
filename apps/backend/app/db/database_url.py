def normalize_async_postgresql_url(database_url: str) -> str:
    scheme, separator, remainder = database_url.partition("://")
    if separator and scheme == "postgresql":
        return f"postgresql+asyncpg://{remainder}"
    return database_url


def prepare_alembic_database_url(database_url: str) -> str:
    """Return a ConfigParser-safe URL without changing its effective value."""
    return normalize_async_postgresql_url(database_url).replace("%", "%%")
