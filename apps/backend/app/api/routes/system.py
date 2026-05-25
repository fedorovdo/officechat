from fastapi import APIRouter

from app.core.config import settings

router = APIRouter()


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
