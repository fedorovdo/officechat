from sqlalchemy.exc import IntegrityError

from app.core.config import settings
from app.db.session import AsyncSessionLocal
from app.models.user import User
from app.services.security import hash_password
from app.services.users import count_users, normalize_username


async def bootstrap_superadmin() -> None:
    async with AsyncSessionLocal() as session:
        if await count_users(session) > 0:
            return

        user = User(
            username=normalize_username(settings.bootstrap_superadmin_username),
            display_name=settings.bootstrap_superadmin_display_name.strip(),
            password_hash=hash_password(settings.bootstrap_superadmin_password),
            role="superadmin",
            is_active=True,
            is_system=False,
            auth_provider="local",
        )
        session.add(user)
        try:
            await session.commit()
        except IntegrityError:
            await session.rollback()
