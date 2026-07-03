from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Request, status
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import get_db, require_admin_user
from app.models.user import User
from app.schemas.retention import (
    RetentionRunRequest,
    RetentionRunResult,
    RetentionSettingsPublic,
    RetentionSettingsUpdate,
    StorageStats,
)
from app.services.retention import (
    audit_dry_run,
    get_retention_settings,
    get_storage_stats,
    run_retention_cleanup,
    update_retention_settings,
)

router = APIRouter()


@router.get("/retention/settings", response_model=RetentionSettingsPublic)
async def get_settings(
    session: Annotated[AsyncSession, Depends(get_db)],
    current_user: Annotated[User, Depends(require_admin_user)],
) -> RetentionSettingsPublic:
    return RetentionSettingsPublic.model_validate(await get_retention_settings(session))


@router.patch("/retention/settings", response_model=RetentionSettingsPublic)
async def patch_settings(
    payload: RetentionSettingsUpdate,
    request: Request,
    session: Annotated[AsyncSession, Depends(get_db)],
    current_user: Annotated[User, Depends(require_admin_user)],
) -> RetentionSettingsPublic:
    current = await get_retention_settings(session)
    updated = await update_retention_settings(session, current, payload, current_user, request)
    return RetentionSettingsPublic.model_validate(updated)


@router.post("/retention/dry-run", response_model=RetentionRunResult)
async def post_dry_run(
    request: Request,
    session: Annotated[AsyncSession, Depends(get_db)],
    current_user: Annotated[User, Depends(require_admin_user)],
) -> RetentionRunResult:
    current = await get_retention_settings(session)
    return await audit_dry_run(session, current, current_user, request)


@router.post("/retention/run", response_model=RetentionRunResult)
async def post_run(
    payload: RetentionRunRequest,
    request: Request,
    session: Annotated[AsyncSession, Depends(get_db)],
    current_user: Annotated[User, Depends(require_admin_user)],
) -> RetentionRunResult:
    if not payload.confirm:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Explicit cleanup confirmation is required",
        )
    current = await get_retention_settings(session)
    try:
        return await run_retention_cleanup(session, current, current_user, request)
    except PermissionError as exc:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=str(exc)) from exc
    except RuntimeError as exc:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=str(exc)) from exc


@router.get("/storage/stats", response_model=StorageStats)
async def get_stats(
    session: Annotated[AsyncSession, Depends(get_db)],
    current_user: Annotated[User, Depends(require_admin_user)],
) -> StorageStats:
    return await get_storage_stats(session)
