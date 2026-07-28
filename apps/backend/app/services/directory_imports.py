import uuid
from collections.abc import Sequence
from typing import Any
from uuid import UUID

from sqlalchemy import delete, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.directory_import import DirectoryImportBatch, DirectoryImportRow
from app.models.user import User
from app.schemas.directory_import import (
    DirectoryImportBatchUpdate,
    DirectoryImportRowUpdate,
)
from app.services.directory_import_parser import (
    ImportCandidate,
    ParsedDirectoryFile,
    SourceRow,
    detect_parser_mode,
    detect_table_header,
    parse_legacy_layout,
    parse_table_sheet,
)


class DirectoryImportNotFoundError(LookupError):
    pass


class DirectoryImportStateError(ValueError):
    pass


IMMUTABLE_IMPORT_STATES = {"executing", "completed", "cancelled"}


def require_mutable_import(batch: DirectoryImportBatch) -> None:
    if batch.status in IMMUTABLE_IMPORT_STATES:
        raise DirectoryImportStateError(
            f"Import batches in {batch.status} state cannot be changed"
        )


def batch_visibility_condition(user: User):
    if user.role == "superadmin":
        return True
    return DirectoryImportBatch.created_by_user_id == user.id


async def create_import_batch(
    session: AsyncSession,
    *,
    parsed: ParsedDirectoryFile,
    original_filename: str,
    actor: User,
) -> DirectoryImportBatch:
    batch = DirectoryImportBatch(
        id=uuid.uuid4(),
        original_filename=original_filename,
        file_type=parsed.file_type,
        file_sha256=parsed.file_sha256,
        available_sheets=parsed.available_sheets,
        selected_sheet=parsed.selected_sheet,
        parser_mode=parsed.parser_mode,
        column_mapping=parsed.column_mapping,
        source_columns=parsed.source_columns,
        status="analyzed",
        total_source_rows=parsed.total_source_rows,
        created_by_user_id=actor.id,
    )
    session.add(batch)
    await session.flush()
    await _replace_rows(session, batch, parsed.candidates)
    return batch


async def list_import_batches(
    session: AsyncSession,
    *,
    actor: User,
    page: int,
    limit: int,
) -> tuple[list[DirectoryImportBatch], int]:
    visibility = batch_visibility_condition(actor)
    total = int(
        await session.scalar(
            select(func.count(DirectoryImportBatch.id)).where(visibility)
        )
        or 0
    )
    result = await session.execute(
        select(DirectoryImportBatch)
        .where(visibility)
        .order_by(DirectoryImportBatch.created_at.desc(), DirectoryImportBatch.id.desc())
        .offset((page - 1) * limit)
        .limit(limit)
    )
    return list(result.scalars().all()), total


async def get_import_batch(
    session: AsyncSession,
    batch_id: UUID,
    *,
    actor: User,
    for_update: bool = False,
) -> DirectoryImportBatch:
    statement = select(DirectoryImportBatch).where(
            DirectoryImportBatch.id == batch_id,
            batch_visibility_condition(actor),
        )
    if for_update:
        statement = statement.with_for_update()
    batch = await session.scalar(statement)
    if batch is None:
        raise DirectoryImportNotFoundError("Directory import batch not found")
    return batch


async def list_import_rows(
    session: AsyncSession,
    batch: DirectoryImportBatch,
    *,
    warnings_only: bool,
    match_status: str | None = None,
    page: int,
    limit: int,
) -> tuple[list[DirectoryImportRow], int]:
    conditions = [DirectoryImportRow.batch_id == batch.id]
    if batch.selected_sheet:
        conditions.append(DirectoryImportRow.source_sheet == batch.selected_sheet)
    if warnings_only:
        conditions.append(func.jsonb_array_length(DirectoryImportRow.warnings) > 0)
    if match_status is not None:
        conditions.append(DirectoryImportRow.match_status == match_status)
    total = int(
        await session.scalar(select(func.count(DirectoryImportRow.id)).where(*conditions)) or 0
    )
    result = await session.execute(
        select(DirectoryImportRow)
        .where(*conditions)
        .order_by(DirectoryImportRow.sort_order.asc(), DirectoryImportRow.id.asc())
        .offset((page - 1) * limit)
        .limit(limit)
    )
    return list(result.scalars().all()), total


async def update_import_batch(
    session: AsyncSession,
    batch: DirectoryImportBatch,
    payload: DirectoryImportBatchUpdate,
) -> DirectoryImportBatch:
    require_mutable_import(batch)
    fields = payload.model_fields_set
    if "selected_sheet" in fields:
        if payload.selected_sheet not in batch.available_sheets:
            raise DirectoryImportStateError("Selected sheet does not exist")
        if payload.selected_sheet != batch.selected_sheet:
            batch.column_mapping = {}
            batch.source_columns = []
        batch.selected_sheet = payload.selected_sheet
    if "parser_mode" in fields and payload.parser_mode is not None:
        batch.parser_mode = payload.parser_mode
    if "column_mapping" in fields and payload.column_mapping is not None:
        batch.column_mapping = payload.column_mapping
    batch.status = "draft"
    batch.version = getattr(batch, "version", 1) + 1
    await session.flush()
    await session.refresh(batch)
    return batch


async def update_import_row(
    session: AsyncSession,
    batch: DirectoryImportBatch,
    row_id: UUID,
    payload: DirectoryImportRowUpdate,
) -> DirectoryImportRow:
    require_mutable_import(batch)
    row = await session.scalar(
        select(DirectoryImportRow).where(
            DirectoryImportRow.id == row_id,
            DirectoryImportRow.batch_id == batch.id,
        )
    )
    if row is None:
        raise DirectoryImportNotFoundError("Directory import row not found")
    fields = payload.model_fields_set
    if "detected_kind" in fields and payload.detected_kind is not None:
        row.detected_kind = payload.detected_kind
    if "normalized_data" in fields and payload.normalized_data is not None:
        row.normalized_data = payload.normalized_data.model_dump()
        row.warnings = [
            warning
            for warning in row.warnings
            if warning.get("code") != "missing_display_name"
        ]
        if not str(row.normalized_data.get("display_name") or "").strip():
            row.warnings = [
                *row.warnings,
                {"code": "missing_display_name", "severity": "blocking"},
            ]
    if "proposed_action" in fields and payload.proposed_action is not None:
        row.proposed_action = payload.proposed_action
    if "is_selected" in fields and payload.is_selected is not None:
        if payload.is_selected and _has_blocking_warning(row.warnings):
            raise DirectoryImportStateError("Rows with blocking errors cannot be selected")
        row.is_selected = payload.is_selected
    if row.proposed_action == "skip":
        row.is_selected = False
    elif row.is_selected and not str(row.normalized_data.get("display_name") or "").strip():
        raise DirectoryImportStateError("Selected rows require a display name")
    await session.flush()
    await session.refresh(row)
    await refresh_batch_counts(session, batch)
    batch.status = "analyzed"
    batch.version = getattr(batch, "version", 1) + 1
    return row


async def reanalyze_import_batch(
    session: AsyncSession, batch: DirectoryImportBatch
) -> DirectoryImportBatch:
    require_mutable_import(batch)
    rows = list(
        (
            await session.execute(
                select(DirectoryImportRow)
                .where(DirectoryImportRow.batch_id == batch.id)
                .order_by(DirectoryImportRow.sort_order.asc())
            )
        )
        .scalars()
        .all()
    )
    source_rows = _reconstruct_source_rows(rows)
    if not source_rows:
        raise DirectoryImportStateError("Import batch has no source rows")
    candidates: list[ImportCandidate] = []
    source_columns: list[dict[str, Any]] = []
    mapping = batch.column_mapping
    for sheet_name in batch.available_sheets:
        sheet_rows = source_rows.get(sheet_name)
        if not sheet_rows:
            continue
        mode = detect_parser_mode(sheet_rows) if batch.parser_mode == "auto" else batch.parser_mode
        if mode == "table":
            sheet_candidates, sheet_mapping, columns = parse_table_sheet(
                sheet_rows,
                column_mapping=mapping if sheet_name == batch.selected_sheet else None,
            )
            if sheet_name == batch.selected_sheet:
                mapping = sheet_mapping
                source_columns = columns
        else:
            sheet_candidates = parse_legacy_layout(sheet_rows)
            if sheet_name == batch.selected_sheet:
                _, _, source_columns = detect_table_header(sheet_rows)
        if sheet_name != batch.selected_sheet:
            for candidate in sheet_candidates:
                candidate.is_selected = False
                candidate.proposed_action = "skip"
        candidates.extend(sheet_candidates)
    for index, candidate in enumerate(candidates):
        candidate.sort_order = index
    batch.column_mapping = mapping
    batch.source_columns = source_columns
    batch.status = "analyzed"
    batch.version = getattr(batch, "version", 1) + 1
    await _replace_rows(session, batch, candidates)
    return batch


async def cancel_import_batch(
    session: AsyncSession, batch: DirectoryImportBatch
) -> DirectoryImportBatch:
    if batch.status == "cancelled":
        return batch
    if batch.status in {"executing", "completed"}:
        raise DirectoryImportStateError(
            f"Import batches in {batch.status} state cannot be cancelled"
        )
    batch.status = "cancelled"
    await session.execute(
        delete(DirectoryImportRow).where(DirectoryImportRow.batch_id == batch.id)
    )
    batch.detected_rows = 0
    batch.selected_rows = 0
    batch.warning_rows = 0
    await session.flush()
    await session.refresh(batch)
    return batch


async def refresh_batch_counts(
    session: AsyncSession, batch: DirectoryImportBatch
) -> None:
    conditions = [DirectoryImportRow.batch_id == batch.id]
    if batch.selected_sheet:
        conditions.append(DirectoryImportRow.source_sheet == batch.selected_sheet)
    counts = (
        await session.execute(
            select(
                func.count(DirectoryImportRow.id),
                func.count(DirectoryImportRow.id).filter(DirectoryImportRow.is_selected.is_(True)),
                func.count(DirectoryImportRow.id).filter(
                    func.jsonb_array_length(DirectoryImportRow.warnings) > 0
                ),
            ).where(*conditions)
        )
    ).one()
    batch.detected_rows = int(counts[0] or 0)
    batch.selected_rows = int(counts[1] or 0)
    batch.warning_rows = int(counts[2] or 0)
    await session.flush()
    await session.refresh(batch)


async def _replace_rows(
    session: AsyncSession,
    batch: DirectoryImportBatch,
    candidates: Sequence[ImportCandidate],
) -> None:
    await session.execute(delete(DirectoryImportRow).where(DirectoryImportRow.batch_id == batch.id))
    for candidate in candidates:
        session.add(
            DirectoryImportRow(
                id=uuid.uuid4(),
                batch_id=batch.id,
                source_sheet=candidate.source_sheet,
                source_row_start=candidate.source_row_start,
                source_row_end=candidate.source_row_end,
                raw_cells=candidate.raw_cells,
                detected_kind=candidate.detected_kind,
                confidence=candidate.confidence,
                normalized_data=candidate.normalized_data,
                warnings=candidate.warnings,
                is_selected=candidate.is_selected,
                proposed_action=candidate.proposed_action,
                sort_order=candidate.sort_order,
            )
        )
    await session.flush()
    await refresh_batch_counts(session, batch)


def _reconstruct_source_rows(
    rows: list[DirectoryImportRow],
) -> dict[str, list[SourceRow]]:
    unique: dict[tuple[str, int], SourceRow] = {}
    for candidate in rows:
        sheet = candidate.source_sheet or "CSV"
        raw_rows = list(candidate.raw_cells.get("rows", []))
        header_row = candidate.raw_cells.get("header_row")
        if isinstance(header_row, dict):
            raw_rows.append(header_row)
        for raw_row in raw_rows:
            row_number = int(raw_row.get("row") or 0)
            if row_number <= 0:
                continue
            unique[(sheet, row_number)] = SourceRow(
                sheet=sheet,
                row_number=row_number,
                cells=[str(value) for value in raw_row.get("cells", [])],
                formula_columns=[int(value) for value in raw_row.get("formula_columns", [])],
                formula_without_cached_value_columns=[
                    int(value)
                    for value in raw_row.get(
                        "formula_without_cached_value_columns",
                        [],
                    )
                ],
                truncated_columns=[
                    int(value) for value in raw_row.get("truncated_columns", [])
                ],
            )
    result: dict[str, list[SourceRow]] = {}
    for (sheet, _), source_row in sorted(unique.items(), key=lambda item: (item[0][0], item[0][1])):
        result.setdefault(sheet, []).append(source_row)
    return result


def _has_blocking_warning(warnings: list[dict[str, Any]]) -> bool:
    return any(item.get("severity") == "blocking" for item in warnings)
