from fastapi import APIRouter, HTTPException

from app.db.postgres import check_postgres_connection

router = APIRouter()


@router.get("/db-check")
async def db_check() -> dict[str, str]:
    try:
        await check_postgres_connection()
    except Exception as exc:
        raise HTTPException(status_code=503, detail=f"PostgreSQL check failed: {exc}") from exc

    return {"status": "ok", "service": "postgres"}
