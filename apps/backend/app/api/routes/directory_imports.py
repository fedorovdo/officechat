import json
import logging
import os
import tempfile
from pathlib import Path
from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Depends, File, Form, HTTPException, Query, Request, UploadFile, status
from fastapi.concurrency import run_in_threadpool
from pydantic import ValidationError
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import get_db, require_can_manage_directory
from app.core.config import settings
from app.models.user import User
from app.schemas.directory_import import (
    DirectoryImportBatchPage,
    DirectoryImportBatchPublic,
    DirectoryImportBatchUpdate,
    DirectoryImportParserMode,
    DirectoryImportRowPage,
    DirectoryImportRowPublic,
    DirectoryImportRowUpdate,
)
from app.services.audit import record_audit_event
from app.services.directory_import_parser import (
    DirectoryImportError,
    DirectoryImportFormatError,
    DirectoryImportLimitError,
    ImportLimits,
    parse_directory_file,
    safe_original_filename,
)
from app.services.directory_imports import (
    DirectoryImportNotFoundError,
    DirectoryImportStateError,
    cancel_import_batch,
    create_import_batch,
    get_import_batch,
    list_import_batches,
    list_import_rows,
    reanalyze_import_batch,
    update_import_batch,
    update_import_row,
)

router = APIRouter()
logger = logging.getLogger(__name__)


def import_limits() -> ImportLimits:
    return ImportLimits(
        max_file_size_bytes=settings.directory_import_max_file_size_bytes,
        max_sheets=settings.directory_import_max_sheets,
        max_rows=settings.directory_import_max_rows,
        max_columns=settings.directory_import_max_columns,
        max_cells=settings.directory_import_max_cells,
        max_cell_length=settings.directory_import_max_cell_length,
        max_zip_members=settings.directory_import_max_zip_members,
        max_uncompressed_bytes=settings.directory_import_max_uncompressed_bytes,
    )


def import_http_error(exc: Exception) -> HTTPException:
    if isinstance(exc, DirectoryImportNotFoundError):
        return HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Import batch not found")
    if isinstance(exc, DirectoryImportStateError):
        return HTTPException(status_code=status.HTTP_409_CONFLICT, detail=str(exc))
    if isinstance(exc, DirectoryImportLimitError):
        return HTTPException(status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE, detail=str(exc))
    if isinstance(exc, DirectoryImportFormatError):
        return HTTPException(status_code=status.HTTP_415_UNSUPPORTED_MEDIA_TYPE, detail=str(exc))
    if isinstance(exc, DirectoryImportError):
        return HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail=str(exc))
    return HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Directory import operation failed")


def safe_import_audit_details(batch, *, include_counts: bool) -> dict[str, object]:
    details: dict[str, object] = {
        "batch_id": str(batch.id),
        "filename": batch.original_filename,
        "hash_prefix": batch.file_sha256[:12],
        "parser_mode": batch.parser_mode,
    }
    if include_counts:
        details.update(
            {
                "total_source_rows": batch.total_source_rows,
                "detected_rows": batch.detected_rows,
                "selected_rows": batch.selected_rows,
                "warning_rows": batch.warning_rows,
            }
        )
    return details


@router.post("/upload", response_model=DirectoryImportBatchPublic, status_code=status.HTTP_201_CREATED)
async def upload_directory_import(
    request: Request,
    file: Annotated[UploadFile, File()],
    session: Annotated[AsyncSession, Depends(get_db)],
    current_user: Annotated[User, Depends(require_can_manage_directory)],
    parser_mode: Annotated[DirectoryImportParserMode, Form()] = "auto",
    selected_sheet: Annotated[str | None, Form(max_length=255)] = None,
    column_mapping: Annotated[str | None, Form(max_length=10000)] = None,
) -> DirectoryImportBatchPublic:
    original_filename = safe_original_filename(file.filename)
    suffix = Path(original_filename).suffix.lower()
    if suffix not in {".xlsx", ".csv"}:
        raise import_http_error(DirectoryImportFormatError("Only XLSX and CSV files are supported"))
    mapping: dict[str, str] | None = None
    if column_mapping:
        try:
            decoded = json.loads(column_mapping)
            mapping = DirectoryImportBatchUpdate(
                column_mapping=decoded
            ).column_mapping
        except (json.JSONDecodeError, TypeError, ValidationError) as exc:
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                detail="Invalid column mapping JSON",
            ) from exc

    temporary_path: str | None = None
    try:
        with tempfile.NamedTemporaryFile(prefix="officechat-directory-", suffix=suffix, delete=False) as target:
            temporary_path = target.name
            size = 0
            while chunk := await file.read(1024 * 1024):
                size += len(chunk)
                if size > settings.directory_import_max_file_size_bytes:
                    raise DirectoryImportLimitError("File is too large")
                target.write(chunk)
        if size == 0:
            raise DirectoryImportFormatError("Uploaded file is empty")
        parsed = await run_in_threadpool(
            parse_directory_file,
            temporary_path,
            original_filename=original_filename,
            parser_mode=parser_mode,
            selected_sheet=selected_sheet,
            column_mapping=mapping,
            limits=import_limits(),
        )
        batch = await create_import_batch(
            session,
            parsed=parsed,
            original_filename=original_filename,
            actor=current_user,
        )
        safe_audit = safe_import_audit_details(batch, include_counts=False)
        safe_audit["file_type"] = batch.file_type
        await record_audit_event(
            session,
            event_type="directory_import_uploaded",
            category="directory",
            action="upload",
            status="success",
            actor=current_user,
            target_type="directory_import_batch",
            target_id=batch.id,
            target_label=original_filename,
            details=safe_audit,
            request=request,
        )
        await record_audit_event(
            session,
            event_type="directory_import_analyzed",
            category="directory",
            action="analyze",
            status="success",
            actor=current_user,
            target_type="directory_import_batch",
            target_id=batch.id,
            target_label=original_filename,
            details=safe_import_audit_details(batch, include_counts=True),
            request=request,
        )
        response = DirectoryImportBatchPublic.model_validate(batch)
        await session.commit()
        return response
    except HTTPException:
        await session.rollback()
        raise
    except Exception as exc:
        await session.rollback()
        raise import_http_error(exc) from exc
    finally:
        await file.close()
        if temporary_path:
            try:
                os.unlink(temporary_path)
            except FileNotFoundError:
                pass
            except OSError:
                logger.warning("Could not remove a temporary directory import file")


@router.get("", response_model=DirectoryImportBatchPage)
async def get_directory_imports(
    session: Annotated[AsyncSession, Depends(get_db)],
    current_user: Annotated[User, Depends(require_can_manage_directory)],
    page: Annotated[int, Query(ge=1)] = 1,
    limit: Annotated[int, Query(ge=1, le=100)] = 30,
) -> DirectoryImportBatchPage:
    rows, total = await list_import_batches(session, actor=current_user, page=page, limit=limit)
    return DirectoryImportBatchPage(items=rows, total=total, page=page, limit=limit)


@router.get("/{batch_id}", response_model=DirectoryImportBatchPublic)
async def get_directory_import(
    batch_id: UUID,
    session: Annotated[AsyncSession, Depends(get_db)],
    current_user: Annotated[User, Depends(require_can_manage_directory)],
) -> DirectoryImportBatchPublic:
    try:
        return DirectoryImportBatchPublic.model_validate(
            await get_import_batch(session, batch_id, actor=current_user)
        )
    except Exception as exc:
        raise import_http_error(exc) from exc


@router.get("/{batch_id}/rows", response_model=DirectoryImportRowPage)
async def get_directory_import_rows(
    batch_id: UUID,
    session: Annotated[AsyncSession, Depends(get_db)],
    current_user: Annotated[User, Depends(require_can_manage_directory)],
    warnings_only: bool = False,
    page: Annotated[int, Query(ge=1)] = 1,
    limit: Annotated[int, Query(ge=1, le=200)] = 100,
) -> DirectoryImportRowPage:
    try:
        batch = await get_import_batch(session, batch_id, actor=current_user)
        rows, total = await list_import_rows(
            session, batch, warnings_only=warnings_only, page=page, limit=limit
        )
        return DirectoryImportRowPage(items=rows, total=total, page=page, limit=limit)
    except Exception as exc:
        raise import_http_error(exc) from exc


@router.patch("/{batch_id}", response_model=DirectoryImportBatchPublic)
async def patch_directory_import(
    batch_id: UUID,
    payload: DirectoryImportBatchUpdate,
    session: Annotated[AsyncSession, Depends(get_db)],
    current_user: Annotated[User, Depends(require_can_manage_directory)],
) -> DirectoryImportBatchPublic:
    try:
        batch = await get_import_batch(session, batch_id, actor=current_user)
        response = DirectoryImportBatchPublic.model_validate(
            await update_import_batch(session, batch, payload)
        )
        await session.commit()
        return response
    except Exception as exc:
        await session.rollback()
        raise import_http_error(exc) from exc


@router.patch("/{batch_id}/rows/{row_id}", response_model=DirectoryImportRowPublic)
async def patch_directory_import_row(
    batch_id: UUID,
    row_id: UUID,
    payload: DirectoryImportRowUpdate,
    session: Annotated[AsyncSession, Depends(get_db)],
    current_user: Annotated[User, Depends(require_can_manage_directory)],
) -> DirectoryImportRowPublic:
    try:
        batch = await get_import_batch(session, batch_id, actor=current_user)
        response = DirectoryImportRowPublic.model_validate(
            await update_import_row(session, batch, row_id, payload)
        )
        await session.commit()
        return response
    except Exception as exc:
        await session.rollback()
        raise import_http_error(exc) from exc


@router.post("/{batch_id}/reanalyze", response_model=DirectoryImportBatchPublic)
async def post_directory_import_reanalyze(
    batch_id: UUID,
    request: Request,
    session: Annotated[AsyncSession, Depends(get_db)],
    current_user: Annotated[User, Depends(require_can_manage_directory)],
) -> DirectoryImportBatchPublic:
    try:
        batch = await get_import_batch(session, batch_id, actor=current_user)
        await reanalyze_import_batch(session, batch)
        await record_audit_event(
            session,
            event_type="directory_import_analyzed",
            category="directory",
            action="reanalyze",
            status="success",
            actor=current_user,
            target_type="directory_import_batch",
            target_id=batch.id,
            target_label=batch.original_filename,
            details=safe_import_audit_details(batch, include_counts=True),
            request=request,
        )
        response = DirectoryImportBatchPublic.model_validate(batch)
        await session.commit()
        return response
    except Exception as exc:
        await session.rollback()
        raise import_http_error(exc) from exc


@router.delete("/{batch_id}", response_model=DirectoryImportBatchPublic)
async def delete_directory_import(
    batch_id: UUID,
    request: Request,
    session: Annotated[AsyncSession, Depends(get_db)],
    current_user: Annotated[User, Depends(require_can_manage_directory)],
) -> DirectoryImportBatchPublic:
    try:
        batch = await get_import_batch(session, batch_id, actor=current_user)
        await cancel_import_batch(session, batch)
        await record_audit_event(
            session,
            event_type="directory_import_cancelled",
            category="directory",
            action="cancel",
            status="success",
            actor=current_user,
            target_type="directory_import_batch",
            target_id=batch.id,
            target_label=batch.original_filename,
            details=safe_import_audit_details(batch, include_counts=False)
            | {"selected_rows": batch.selected_rows},
            request=request,
        )
        response = DirectoryImportBatchPublic.model_validate(batch)
        await session.delete(batch)
        await session.commit()
        return response
    except Exception as exc:
        await session.rollback()
        raise import_http_error(exc) from exc
