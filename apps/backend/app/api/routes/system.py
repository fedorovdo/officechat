from typing import Annotated

from fastapi import APIRouter, Depends

from app.api.deps import require_superadmin_user
from app.core.config import settings
from app.models.user import User
from app.services.release_updates import available_update

router = APIRouter()


@router.get("/updates")
async def release_update(_: Annotated[User, Depends(require_superadmin_user)]) -> dict[str, str | None]:
    return await available_update(settings.app_version)


@router.get("/info")
async def system_info() -> dict[str, object]:
    return {
        "name": settings.app_name,
        "version": settings.app_version,
        "environment": settings.environment,
        "self_registration_enabled": settings.self_registration_enabled,
        "storage": "local-volume",
        "cache": "valkey",
        "auth": {
            "default_user_flow": "admin-created-users",
            "providers_planned": ["local", "ldap-ad"],
        },
        "bots": {
            "foundation": "planned",
            "ai_provider_targets": ["ollama", "openai-compatible"],
        },
    }
