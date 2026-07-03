import re
from datetime import datetime, timezone
from uuid import UUID

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.models.bot import Bot
from app.models.user import User
from app.schemas.bot import BotCreate, BotUpdate
from app.services.security import generate_secure_token, hash_token, token_preview, verify_token
from app.services.users import get_user_by_username


def normalize_bot_base_username(name: str) -> str:
    normalized = re.sub(r"[^a-z0-9]+", "_", name.strip().lower())
    normalized = re.sub(r"_+", "_", normalized).strip("_")
    if not normalized:
        normalized = "bot"
    if not normalized.endswith("_bot"):
        normalized = f"{normalized}_bot"
    return normalized[:58]


async def generate_bot_username(session: AsyncSession, name: str) -> str:
    base_username = normalize_bot_base_username(name)
    candidate = base_username
    suffix = 2
    while await get_user_by_username(session, candidate):
        suffix_text = f"_{suffix}"
        candidate = f"{base_username[:64 - len(suffix_text)]}{suffix_text}"
        suffix += 1
    return candidate


async def load_bot_with_user(session: AsyncSession, bot_id: UUID) -> Bot | None:
    result = await session.execute(
        select(Bot).options(selectinload(Bot.user)).where(Bot.id == bot_id)
    )
    return result.scalar_one_or_none()


async def list_bots(session: AsyncSession) -> list[Bot]:
    result = await session.execute(select(Bot).options(selectinload(Bot.user)).order_by(Bot.created_at.asc()))
    return list(result.scalars().all())


async def create_bot(
    session: AsyncSession, payload: BotCreate, current_user: User, *, commit: bool = True
) -> tuple[Bot, str]:
    token = generate_secure_token()
    user = User(
        username=await generate_bot_username(session, payload.name),
        display_name=payload.name.strip(),
        email=None,
        password_hash=None,
        role="bot",
        is_active=True,
        is_system=False,
        auth_provider="bot",
    )
    session.add(user)
    await session.flush()

    bot = Bot(
        user_id=user.id,
        name=payload.name.strip(),
        description=payload.description.strip() if payload.description else None,
        token_hash=hash_token(token),
        token_preview=token_preview(token),
        is_active=True,
        created_by_user_id=current_user.id,
    )
    session.add(bot)
    if commit:
        await session.commit()
    else:
        await session.flush()
    loaded_bot = await load_bot_with_user(session, bot.id)
    if loaded_bot is None:
        raise RuntimeError("Created bot could not be loaded")
    return loaded_bot, token


async def update_bot(session: AsyncSession, bot: Bot, payload: BotUpdate, *, commit: bool = True) -> Bot:
    update_fields = payload.model_fields_set
    if "name" in update_fields and payload.name is not None:
        bot.name = payload.name.strip()
        bot.user.display_name = bot.name
    if "description" in update_fields:
        bot.description = payload.description.strip() if payload.description else None
    if "is_active" in update_fields and payload.is_active is not None:
        bot.is_active = payload.is_active
        bot.user.is_active = payload.is_active

    if commit:
        await session.commit()
    else:
        await session.flush()
    loaded_bot = await load_bot_with_user(session, bot.id)
    if loaded_bot is None:
        raise RuntimeError("Updated bot could not be loaded")
    return loaded_bot


async def rotate_bot_token(session: AsyncSession, bot: Bot, *, commit: bool = True) -> tuple[Bot, str]:
    token = generate_secure_token()
    bot.token_hash = hash_token(token)
    bot.token_preview = token_preview(token)
    if commit:
        await session.commit()
    else:
        await session.flush()
    loaded_bot = await load_bot_with_user(session, bot.id)
    if loaded_bot is None:
        raise RuntimeError("Updated bot could not be loaded")
    return loaded_bot, token


async def authenticate_bot_by_token(session: AsyncSession, token: str) -> Bot | None:
    result = await session.execute(select(Bot).options(selectinload(Bot.user)).where(Bot.is_active.is_(True)))
    for bot in result.scalars().all():
        if verify_token(token, bot.token_hash):
            if not bot.user.is_active:
                return None
            bot.last_used_at = datetime.now(timezone.utc)
            await session.commit()
            await session.refresh(bot)
            return await load_bot_with_user(session, bot.id)
    return None
