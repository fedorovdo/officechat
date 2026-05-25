from fastapi import APIRouter, HTTPException

from app.services.cache import check_valkey_connection

router = APIRouter()


@router.get("/cache-check")
async def cache_check() -> dict[str, str]:
    try:
        await check_valkey_connection()
    except Exception as exc:
        raise HTTPException(status_code=503, detail=f"Valkey check failed: {exc}") from exc

    return {"status": "ok", "service": "valkey"}
