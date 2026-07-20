from logging.config import fileConfig

from alembic import context
from sqlalchemy import pool
from sqlalchemy.ext.asyncio import async_engine_from_config

from app.core.config import settings
from app.db.base import Base
from app.db.database_url import prepare_alembic_database_url
from app.models import (
    AuditEvent,
    Bot,
    ChatReadState,
    DirectMessageAttachment,
    Discussion,
    DiscussionMember,
    DiscussionMessage,
    DiscussionMessageAttachment,
    DiscussionMessageReaction,
    DirectMessageReaction,
    Group,
    GroupMember,
    GroupMessageReaction,
    Message,
    MessageAttachment,
    RetentionAudit,
    RetentionSettings,
    MessageMention,
    User,
)

config = context.config
config.set_main_option("sqlalchemy.url", prepare_alembic_database_url(settings.database_url))

if config.config_file_name is not None:
    fileConfig(config.config_file_name)

target_metadata = Base.metadata


def run_migrations_offline() -> None:
    context.configure(
        url=config.get_main_option("sqlalchemy.url"),
        target_metadata=target_metadata,
        literal_binds=True,
        dialect_opts={"paramstyle": "named"},
    )

    with context.begin_transaction():
        context.run_migrations()


def do_run_migrations(connection) -> None:
    context.configure(connection=connection, target_metadata=target_metadata)

    with context.begin_transaction():
        context.run_migrations()


async def run_migrations_online() -> None:
    connectable = async_engine_from_config(
        config.get_section(config.config_ini_section, {}),
        prefix="sqlalchemy.",
        poolclass=pool.NullPool,
    )

    async with connectable.connect() as connection:
        await connection.run_sync(do_run_migrations)

    await connectable.dispose()


if context.is_offline_mode():
    run_migrations_offline()
else:
    import asyncio

    asyncio.run(run_migrations_online())
