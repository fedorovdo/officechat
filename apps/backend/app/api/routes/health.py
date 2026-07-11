from pathlib import Path
import tempfile

from fastapi import APIRouter
from fastapi.responses import JSONResponse

from app.core.config import settings
from app.db.postgres import check_postgres_connection, get_alembic_revision
from app.services.cache import check_valkey_connection

router = APIRouter(tags=["health"])


@router.get("/health")
async def health() -> dict[str, str]:
    return {"status": "ok", "version": settings.app_version, "service": "officechat-backend"}


def check_uploads_writable() -> dict[str, object]:
    uploads_dir = Path(settings.uploads_dir)
    uploads_dir.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(prefix=".officechat-ready-", dir=uploads_dir, delete=True) as probe:
        probe.write(b"ok")
        probe.flush()

    result: dict[str, object] = {"writable": True}
    try:
        usage = __import__("shutil").disk_usage(uploads_dir)
        result["low_space"] = usage.free < settings.max_upload_size_bytes
    except OSError:
        result["low_space"] = None
    return result


@router.get("/ready")
async def ready() -> JSONResponse:
    checks: dict[str, object] = {}
    errors: dict[str, str] = {}

    try:
        await check_postgres_connection()
        checks["postgres"] = {"ok": True}
    except Exception as exc:
        checks["postgres"] = {"ok": False}
        errors["postgres"] = exc.__class__.__name__

    try:
        checks["alembic"] = {"ok": True, "revision": await get_alembic_revision()}
    except Exception as exc:
        checks["alembic"] = {"ok": False, "revision": None}
        errors["alembic"] = exc.__class__.__name__

    try:
        await check_valkey_connection()
        checks["valkey"] = {"ok": True}
    except Exception as exc:
        checks["valkey"] = {"ok": False}
        errors["valkey"] = exc.__class__.__name__

    try:
        checks["uploads"] = {"ok": True, **check_uploads_writable()}
    except Exception as exc:
        checks["uploads"] = {"ok": False, "writable": False, "low_space": None}
        errors["uploads"] = exc.__class__.__name__

    status_code = 200 if not errors else 503
    return JSONResponse(
        status_code=status_code,
        content={
            "status": "ready" if not errors else "not_ready",
            "version": settings.app_version,
            "service": "officechat-backend",
            "checks": checks,
            "errors": errors,
        },
    )
