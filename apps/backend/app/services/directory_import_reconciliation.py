import time
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any
from uuid import UUID

from fastapi import Request
from sqlalchemy import select, text
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.directory import DirectoryEntry
from app.models.directory_import import DirectoryImportBatch, DirectoryImportRow
from app.models.user import User
from app.schemas.directory import DirectoryEntryCreate, DirectoryEntryUpdate
from app.schemas.directory_import import (
    DIRECTORY_IMPORT_UPDATE_FIELDS,
    DirectoryImportExecutionResultPublic,
    DirectoryImportMatchUpdate,
    DirectoryImportValidationPublic,
)
from app.services.audit import record_audit_event
from app.services.directory import (
    canonical_text,
    create_directory_entry,
    normalize_department,
    normalize_display_name,
    normalize_email,
    normalize_phone_digits,
    normalize_position,
    set_directory_entry_active,
    update_directory_entry,
)
from app.services.directory_imports import DirectoryImportStateError, batch_visibility_condition

COMMON_MAILBOXES = {
    "admin",
    "contact",
    "help",
    "hr",
    "info",
    "office",
    "reception",
    "sales",
    "support",
}
PHONE_FIELDS = ("internal_phone", "work_phone", "mobile_phone")
MATCHED_KINDS = {"person"}
DIRECTORY_IMPORT_EXECUTION_LOCK_KEY = 0x4F4344494D505254


class DirectoryImportValidationError(DirectoryImportStateError):
    def __init__(self, message: str, *, code: str = "validation_failed"):
        super().__init__(message)
        self.code = code


@dataclass(slots=True)
class ScoredCandidate:
    entry: DirectoryEntry
    score: float
    reasons: list[dict[str, Any]]


def _now() -> datetime:
    return datetime.now(UTC)


def _has_import_value(value: Any) -> bool:
    return value is not None and (not isinstance(value, str) or bool(value.strip()))


def _timestamps_match(current: datetime | None, expected: datetime | None) -> bool:
    if current is None or expected is None:
        return False
    if current.tzinfo is None:
        current = current.replace(tzinfo=UTC)
    if expected.tzinfo is None:
        expected = expected.replace(tzinfo=UTC)
    return current.astimezone(UTC) == expected.astimezone(UTC)


def _is_personal_email(value: str) -> bool:
    local = value.partition("@")[0]
    return bool(value and "@" in value and local not in COMMON_MAILBOXES)


def _entry_snapshot(entry: DirectoryEntry, score: float, reasons: list[dict[str, Any]]) -> dict[str, Any]:
    return {
        "id": str(entry.id),
        "display_name": entry.display_name,
        "department": entry.department,
        "position": entry.position,
        "internal_phone": entry.internal_phone,
        "work_phone": entry.work_phone,
        "mobile_phone": entry.mobile_phone,
        "email": entry.email,
        "room": entry.room,
        "location": entry.location,
        "is_active": entry.is_active,
        "updated_at": entry.updated_at.isoformat(),
        "score": score,
        "reasons": reasons,
    }


def score_directory_match(data: dict[str, Any], entry: DirectoryEntry) -> ScoredCandidate | None:
    name = normalize_display_name(data.get("display_name"))
    entry_name = normalize_display_name(entry.display_name)
    department = normalize_department(data.get("department"))
    entry_department = normalize_department(entry.department)
    position = normalize_position(data.get("position"))
    entry_position = normalize_position(entry.position)
    email = normalize_email(data.get("email"))
    entry_email = normalize_email(entry.email)
    reasons: list[dict[str, Any]] = []
    score = 0.0

    exact_personal_email = bool(
        email and email == entry_email and _is_personal_email(email)
    )
    if exact_personal_email:
        score += 100
        reasons.append({"code": "exact_email", "weight": 100})

    imported_phones = {
        field: normalize_phone_digits(data.get(field))
        for field in PHONE_FIELDS
    }
    existing_phones = {
        field: normalize_phone_digits(getattr(entry, field))
        for field in PHONE_FIELDS
    }
    long_phone_matches = [
        field
        for field, value in imported_phones.items()
        if len(value) >= 7 and value == existing_phones[field]
    ]
    short_phone_matches = [
        field
        for field, value in imported_phones.items()
        if 2 < len(value) < 7 and value == existing_phones[field]
    ]
    if long_phone_matches:
        weight = 70 if name and name == entry_name else 55
        score += weight
        reasons.append({"code": "exact_long_phone", "weight": weight})
    elif short_phone_matches and department and department == entry_department:
        score += 30
        reasons.append({"code": "short_phone_with_department", "weight": 30})

    if name and name == entry_name:
        score += 50
        reasons.append({"code": "exact_name", "weight": 50})
    if department and department == entry_department:
        score += 25
        reasons.append({"code": "exact_department", "weight": 25})
    if position and position == entry_position:
        score += 25
        reasons.append({"code": "exact_position", "weight": 25})

    # Conflicting strong identifiers must be shown to the operator, never auto-selected.
    if email and entry_email and email != entry_email and long_phone_matches:
        reasons.append({"code": "identifier_conflict", "weight": -80})
        score = min(score, 65)
    if (
        long_phone_matches
        and department
        and entry_department
        and department != entry_department
        and not exact_personal_email
    ):
        reasons.append({"code": "department_conflict", "weight": -35})
        score = min(score, 65)
    if score < 35:
        return None
    return ScoredCandidate(entry=entry, score=min(score, 100), reasons=reasons)


def find_directory_match_candidates(
    data: dict[str, Any], entries: list[DirectoryEntry]
) -> list[ScoredCandidate]:
    candidates = [
        candidate
        for entry in entries
        if (candidate := score_directory_match(data, entry)) is not None
    ]
    email = normalize_email(data.get("email"))
    imported_phones = {
        normalize_phone_digits(data.get(field))
        for field in PHONE_FIELDS
        if len(normalize_phone_digits(data.get(field))) >= 7
    }
    email_ids = {
        item.entry.id
        for item in candidates
        if email and email == normalize_email(item.entry.email)
    }
    phone_ids = {
        item.entry.id
        for item in candidates
        if imported_phones
        & {
            normalize_phone_digits(getattr(item.entry, field))
            for field in PHONE_FIELDS
        }
    }
    if email_ids and phone_ids and email_ids.isdisjoint(phone_ids):
        for item in candidates:
            item.score = min(item.score, 65)
            if not any(reason["code"] == "identifier_conflict" for reason in item.reasons):
                item.reasons.append({"code": "identifier_conflict", "weight": -80})
    return sorted(candidates, key=lambda item: (-item.score, str(item.entry.id)))[:5]


def classify_directory_match(candidates: list[ScoredCandidate]) -> str:
    if not candidates:
        return "unmatched"
    top = candidates[0]
    close_candidates = [
        item for item in candidates[1:] if top.score - item.score < 10
    ]
    conflicting = any(
        reason["code"] == "identifier_conflict" for reason in top.reasons
    )
    if close_candidates or conflicting or top.score < 60:
        return "ambiguous"
    if not top.entry.is_active:
        return "archived_match"
    return "exact" if top.score >= 90 else "probable"


def _duplicate_keys(row: DirectoryImportRow) -> set[str]:
    data = row.normalized_data
    keys: set[str] = set()
    email = normalize_email(data.get("email"))
    if email and _is_personal_email(email):
        keys.add(f"email:{email}")
    name = normalize_display_name(data.get("display_name"))
    department = normalize_department(data.get("department"))
    position = normalize_position(data.get("position"))
    for field in PHONE_FIELDS:
        phone = normalize_phone_digits(data.get(field))
        if len(phone) >= 7 and name:
            keys.add(f"phone-name:{phone}:{name}")
    if name and department and position:
        keys.add(f"identity:{name}:{department}:{position}")
    normalized = tuple(
        (field, canonical_text(str(data.get(field) or "")))
        for field in sorted(DIRECTORY_IMPORT_UPDATE_FIELDS)
        if _has_import_value(data.get(field))
    )
    if normalized:
        keys.add(f"full:{normalized!r}")
    return keys


def _default_update_fields(row: DirectoryImportRow, entry: DirectoryEntry) -> list[str]:
    selected: list[str] = []
    for field in sorted(DIRECTORY_IMPORT_UPDATE_FIELDS):
        imported = row.normalized_data.get(field)
        if not _has_import_value(imported):
            continue
        existing = getattr(entry, field)
        if canonical_text(str(imported)) != canonical_text(str(existing or "")):
            selected.append(field)
    return selected


async def _lock_batch(
    session: AsyncSession, batch_id: UUID, actor: User
) -> DirectoryImportBatch:
    batch = await session.scalar(
        select(DirectoryImportBatch)
        .where(
            DirectoryImportBatch.id == batch_id,
            batch_visibility_condition(actor),
        )
        .with_for_update()
    )
    if batch is None:
        raise DirectoryImportValidationError("Import batch not found", code="not_found")
    return batch


async def _lock_directory_import_execution(session: AsyncSession) -> None:
    bind = session.get_bind()
    if bind.dialect.name == "postgresql":
        await session.execute(
            text("SELECT pg_advisory_xact_lock(:lock_key)"),
            {"lock_key": DIRECTORY_IMPORT_EXECUTION_LOCK_KEY},
        )


async def reconcile_directory_import_batch(
    session: AsyncSession,
    batch_id: UUID,
    *,
    actor: User,
) -> DirectoryImportBatch:
    batch = await _lock_batch(session, batch_id, actor)
    if batch.status not in {"analyzed", "reconciled", "failed"}:
        raise DirectoryImportValidationError(
            "Only analyzed imports can be reconciled",
            code="invalid_state",
        )
    batch.reconciliation_started_at = _now()
    batch.execution_started_at = None
    batch.executed_at = None
    batch.execution_summary = None
    batch.execution_error = None
    rows = list(
        (
            await session.execute(
                select(DirectoryImportRow)
                .where(
                    DirectoryImportRow.batch_id == batch.id,
                    *(
                        [DirectoryImportRow.source_sheet == batch.selected_sheet]
                        if batch.selected_sheet
                        else []
                    ),
                )
                .order_by(DirectoryImportRow.sort_order, DirectoryImportRow.id)
                .with_for_update()
            )
        )
        .scalars()
        .all()
    )
    entries = list((await session.execute(select(DirectoryEntry))).scalars().all())
    seen_duplicate_keys: dict[str, DirectoryImportRow] = {}

    for row in rows:
        row.match_status = None
        row.matched_entry_id = None
        row.match_score = None
        row.match_reasons = []
        row.match_candidates = []
        row.update_fields = []
        row.restore_if_archived = False
        row.expected_entry_updated_at = None
        row.execution_status = "pending"
        row.result_entry_id = None
        row.execution_error = None

        if row.detected_kind == "organization_metadata":
            row.proposed_action = "skip"
            row.is_selected = False
            continue

        duplicate_of: DirectoryImportRow | None = None
        duplicate_key = ""
        for key in sorted(_duplicate_keys(row)):
            if key in seen_duplicate_keys:
                duplicate_of = seen_duplicate_keys[key]
                duplicate_key = key.split(":", 1)[0]
                break
        for key in _duplicate_keys(row):
            seen_duplicate_keys.setdefault(key, row)
        if duplicate_of is not None:
            row.match_status = "batch_duplicate"
            row.match_reasons = [
                {
                    "code": "batch_duplicate",
                    "weight": 100,
                    "row_id": str(duplicate_of.id),
                    "key": duplicate_key,
                }
            ]
            row.proposed_action = "skip"
            row.is_selected = False
            continue

        if row.detected_kind not in MATCHED_KINDS:
            row.match_status = "unmatched"
            row.proposed_action = "create" if row.detected_kind != "unknown" else "skip"
            row.is_selected = row.proposed_action == "create"
            continue

        candidates = find_directory_match_candidates(row.normalized_data, entries)
        row.match_candidates = [
            _entry_snapshot(item.entry, item.score, item.reasons) for item in candidates
        ]
        match_status = classify_directory_match(candidates)
        if match_status == "unmatched":
            row.match_status = "unmatched"
            row.proposed_action = "create"
            row.is_selected = True
            continue

        top = candidates[0]
        if match_status == "ambiguous":
            row.match_status = "ambiguous"
            row.proposed_action = "skip"
            row.is_selected = False
            row.match_score = top.score
            row.match_reasons = top.reasons
            continue

        row.match_score = top.score
        row.match_reasons = top.reasons
        row.matched_entry_id = top.entry.id
        row.expected_entry_updated_at = top.entry.updated_at
        if match_status == "archived_match":
            row.match_status = "archived_match"
            row.proposed_action = "skip"
            row.is_selected = False
        elif match_status == "exact":
            row.match_status = "exact"
            row.proposed_action = "update"
            row.update_fields = _default_update_fields(row, top.entry)
            row.is_selected = bool(row.update_fields)
            if not row.update_fields:
                row.proposed_action = "skip"
        else:
            row.match_status = "probable"
            row.proposed_action = "skip"
            row.is_selected = False

    batch.status = "reconciled"
    batch.directory_snapshot_at = _now()
    batch.reconciled_at = batch.directory_snapshot_at
    batch.version += 1
    await session.flush()
    await session.refresh(batch)
    return batch


async def update_directory_import_match(
    session: AsyncSession,
    batch_id: UUID,
    row_id: UUID,
    payload: DirectoryImportMatchUpdate,
    *,
    actor: User,
) -> DirectoryImportRow:
    batch = await _lock_batch(session, batch_id, actor)
    if batch.status != "reconciled":
        raise DirectoryImportValidationError("Import batch is not reconciled", code="invalid_state")
    if payload.version != batch.version:
        raise DirectoryImportValidationError("Import batch changed; reload it", code="stale_batch")
    row = await session.scalar(
        select(DirectoryImportRow).where(
            DirectoryImportRow.id == row_id,
            DirectoryImportRow.batch_id == batch.id,
        ).with_for_update()
    )
    if row is None:
        raise DirectoryImportValidationError("Import row not found", code="not_found")
    if payload.proposed_action == "update":
        candidate_ids = {UUID(str(item["id"])) for item in row.match_candidates}
        if payload.matched_entry_id not in candidate_ids:
            raise DirectoryImportValidationError(
                "Selected directory entry is not a match candidate",
                code="invalid_candidate",
            )
        entry = await session.scalar(
            select(DirectoryEntry)
            .where(DirectoryEntry.id == payload.matched_entry_id)
            .with_for_update()
            .execution_options(populate_existing=True)
        )
        if entry is None:
            raise DirectoryImportValidationError("Matched entry no longer exists", code="stale_match")
        if payload.restore_if_archived and entry.is_active:
            raise DirectoryImportValidationError("Only archived entries can be restored")
        if not entry.is_active and not payload.restore_if_archived:
            raise DirectoryImportValidationError(
                "Archived entries must be restored before updating",
                code="restore_required",
            )
        if row.matched_entry_id == entry.id:
            if not _timestamps_match(entry.updated_at, row.expected_entry_updated_at):
                raise DirectoryImportValidationError(
                    "Matched entry changed; reconcile again",
                    code="stale_match",
                )
        else:
            row.expected_entry_updated_at = entry.updated_at
        row.matched_entry_id = entry.id
        row.update_fields = [
            field
            for field in payload.update_fields
            if _has_import_value(row.normalized_data.get(field))
        ]
        if len(row.update_fields) != len(payload.update_fields):
            raise DirectoryImportValidationError(
                "Empty imported values cannot overwrite directory fields",
                code="blank_overwrite",
            )
        row.restore_if_archived = payload.restore_if_archived
        row.is_selected = True
    else:
        row.matched_entry_id = None
        row.expected_entry_updated_at = None
        row.update_fields = []
        row.restore_if_archived = False
        row.is_selected = payload.proposed_action == "create"
    row.proposed_action = payload.proposed_action
    await session.flush()
    await session.refresh(row)
    return row


async def _load_execution_rows(
    session: AsyncSession,
    batch: DirectoryImportBatch,
    *,
    for_update: bool,
) -> list[DirectoryImportRow]:
    statement = (
        select(DirectoryImportRow)
        .where(
            DirectoryImportRow.batch_id == batch.id,
            *(
                [DirectoryImportRow.source_sheet == batch.selected_sheet]
                if batch.selected_sheet
                else []
            ),
        )
        .order_by(DirectoryImportRow.sort_order, DirectoryImportRow.id)
    )
    if for_update:
        statement = statement.with_for_update()
    return list((await session.execute(statement)).scalars().all())


async def _load_execution_entries(
    session: AsyncSession,
    rows: list[DirectoryImportRow],
    *,
    for_update: bool,
) -> list[DirectoryEntry]:
    target_ids = sorted(
        {
            row.matched_entry_id
            for row in rows
            if row.proposed_action == "update" and row.matched_entry_id is not None
        },
        key=str,
    )
    if for_update and target_ids:
        await session.execute(
            select(DirectoryEntry)
            .where(DirectoryEntry.id.in_(target_ids))
            .order_by(DirectoryEntry.id)
            .with_for_update()
            .execution_options(populate_existing=True)
        )
    return list(
        (
            await session.execute(
                select(DirectoryEntry).execution_options(populate_existing=True)
            )
        )
        .scalars()
        .all()
    )


def _validate_directory_import_rows(
    batch: DirectoryImportBatch,
    rows: list[DirectoryImportRow],
    current_entries: list[DirectoryEntry],
) -> DirectoryImportValidationPublic:
    counts = {"create": 0, "update": 0, "restore": 0, "skip": 0}
    blocking: list[dict[str, Any]] = []
    stale_count = 0
    duplicate_count = 0
    create_keys: dict[str, UUID] = {}
    update_targets: dict[UUID, UUID] = {}
    entries_by_id = {entry.id: entry for entry in current_entries}
    for row in rows:
        action = row.proposed_action
        if action == "skip":
            counts["skip"] += 1
            continue
        if not row.is_selected:
            blocking.append({"row_id": str(row.id), "code": "row_not_selected"})
        if any(item.get("severity") == "blocking" for item in row.warnings):
            blocking.append({"row_id": str(row.id), "code": "blocking_warning"})
        if action == "create":
            counts["create"] += 1
            if row.detected_kind in {"organization_metadata", "unknown"}:
                blocking.append({"row_id": str(row.id), "code": "invalid_create_kind"})
            if not _has_import_value(row.normalized_data.get("display_name")):
                blocking.append({"row_id": str(row.id), "code": "missing_display_name"})
            for key in _duplicate_keys(row):
                if key in create_keys:
                    duplicate_count += 1
                    blocking.append({"row_id": str(row.id), "code": "batch_duplicate"})
                    break
                create_keys[key] = row.id
            new_candidates = find_directory_match_candidates(
                row.normalized_data, current_entries
            )
            if new_candidates and new_candidates[0].score >= 90:
                stale_count += 1
                blocking.append(
                    {"row_id": str(row.id), "code": "stale_directory_snapshot"}
                )
            continue
        if row.restore_if_archived:
            counts["restore"] += 1
        else:
            counts["update"] += 1
        if row.matched_entry_id is None or not row.update_fields and not row.restore_if_archived:
            blocking.append({"row_id": str(row.id), "code": "invalid_update"})
            continue
        if row.matched_entry_id in update_targets:
            duplicate_count += 1
            blocking.append({"row_id": str(row.id), "code": "duplicate_update_target"})
        else:
            update_targets[row.matched_entry_id] = row.id
        entry = entries_by_id.get(row.matched_entry_id)
        if entry is None or not _timestamps_match(
            entry.updated_at,
            row.expected_entry_updated_at,
        ):
            stale_count += 1
            blocking.append({"row_id": str(row.id), "code": "stale_match"})
        if row.restore_if_archived and entry is not None and entry.is_active:
            blocking.append({"row_id": str(row.id), "code": "not_archived"})
        if any(
            field not in DIRECTORY_IMPORT_UPDATE_FIELDS
            or not _has_import_value(row.normalized_data.get(field))
            for field in row.update_fields
        ):
            blocking.append({"row_id": str(row.id), "code": "invalid_update_fields"})

    return DirectoryImportValidationPublic(
        create_count=counts["create"],
        update_count=counts["update"],
        restore_count=counts["restore"],
        skip_count=counts["skip"],
        blocking_count=len(blocking),
        stale_count=stale_count,
        invalid_count=max(0, len(blocking) - stale_count - duplicate_count),
        duplicate_count=duplicate_count,
        can_execute=not blocking and batch.status == "reconciled",
        blocking_reasons=blocking[:200],
    )


async def validate_directory_import_execution(
    session: AsyncSession,
    batch: DirectoryImportBatch,
) -> DirectoryImportValidationPublic:
    rows = await _load_execution_rows(session, batch, for_update=False)
    current_entries = await _load_execution_entries(
        session,
        rows,
        for_update=False,
    )
    return _validate_directory_import_rows(batch, rows, current_entries)


async def execute_directory_import_batch(
    session: AsyncSession,
    batch_id: UUID,
    *,
    actor: User,
    version: int,
    request: Request | None,
) -> DirectoryImportExecutionResultPublic:
    started = time.monotonic()
    batch = await _lock_batch(session, batch_id, actor)
    if batch.status == "completed" and batch.execution_summary:
        return DirectoryImportExecutionResultPublic.model_validate(batch.execution_summary)
    if batch.status == "executing":
        raise DirectoryImportValidationError("Import is already executing", code="already_executing")
    if batch.status != "reconciled":
        raise DirectoryImportValidationError("Import batch is not ready", code="invalid_state")
    if batch.version != version:
        raise DirectoryImportValidationError("Import batch changed; reconcile again", code="stale_batch")
    # Serializing execution closes the validation-to-create race across import batches.
    await _lock_directory_import_execution(session)
    rows = await _load_execution_rows(session, batch, for_update=True)
    current_entries = await _load_execution_entries(
        session,
        rows,
        for_update=True,
    )
    validation = _validate_directory_import_rows(batch, rows, current_entries)
    if not validation.can_execute:
        code = "stale_match" if validation.stale_count else "blocking_conflicts"
        raise DirectoryImportValidationError("Import validation failed", code=code)

    batch.status = "executing"
    batch.execution_started_at = _now()
    batch.execution_error = None
    await record_audit_event(
        session,
        event_type="directory_import_execution_started",
        category="directory",
        action="execute",
        status="success",
        actor=actor,
        target_type="directory_import_batch",
        target_id=batch.id,
        target_label=None,
        details={
            "batch_id": str(batch.id),
            "create": validation.create_count,
            "update": validation.update_count,
            "skip": validation.skip_count,
        },
        request=request,
    )
    entries_by_id = {entry.id: entry for entry in current_entries}
    result_ids: list[UUID] = []
    created = updated = restored = skipped = 0
    for row in rows:
        if row.proposed_action == "skip":
            row.execution_status = "skipped"
            skipped += 1
            continue
        if row.proposed_action == "create":
            values = {
                field: value
                for field in DIRECTORY_IMPORT_UPDATE_FIELDS
                if _has_import_value(value := row.normalized_data.get(field))
            }
            entry = await create_directory_entry(
                session,
                DirectoryEntryCreate(**values, linked_user_id=None, is_active=True),
                actor,
            )
            row.execution_status = "created"
            row.result_entry_id = entry.id
            result_ids.append(entry.id)
            created += 1
            await record_audit_event(
                session,
                event_type="directory_entry_created",
                category="directory",
                action="create",
                status="success",
                actor=actor,
                target_type="directory_entry",
                target_id=entry.id,
                target_label=None,
                details={"source": "directory_import", "batch_id": str(batch.id)},
                request=request,
            )
            continue

        entry = entries_by_id.get(row.matched_entry_id)
        if entry is None or not _timestamps_match(
            entry.updated_at,
            row.expected_entry_updated_at,
        ):
            raise DirectoryImportValidationError(
                "Matched entry changed during execution",
                code="stale_match",
            )
        if row.restore_if_archived:
            entry = await set_directory_entry_active(session, entry, actor, is_active=True)
            restored += 1
            await record_audit_event(
                session,
                event_type="directory_entry_restored",
                category="directory",
                action="restore",
                status="success",
                actor=actor,
                target_type="directory_entry",
                target_id=entry.id,
                target_label=None,
                details={"source": "directory_import", "batch_id": str(batch.id)},
                request=request,
            )
        update_values = {
            field: row.normalized_data[field]
            for field in row.update_fields
            if _has_import_value(row.normalized_data.get(field))
        }
        changed_fields: list[str] = []
        if update_values:
            entry, changed_fields = await update_directory_entry(
                session,
                entry,
                DirectoryEntryUpdate(**update_values),
                actor,
            )
            if changed_fields:
                await record_audit_event(
                    session,
                    event_type="directory_entry_updated",
                    category="directory",
                    action="update",
                    status="success",
                    actor=actor,
                    target_type="directory_entry",
                    target_id=entry.id,
                    target_label=None,
                    details={
                        "source": "directory_import",
                        "batch_id": str(batch.id),
                        "changed_fields": changed_fields,
                    },
                    request=request,
                )
        row.execution_status = "restored" if row.restore_if_archived else "updated"
        row.result_entry_id = entry.id
        result_ids.append(entry.id)
        if not row.restore_if_archived:
            updated += 1

    if created + updated + restored + skipped != len(rows):
        raise RuntimeError("Directory import execution counts are inconsistent")

    duration_ms = max(0, round((time.monotonic() - started) * 1000))
    summary = DirectoryImportExecutionResultPublic(
        batch_id=batch.id,
        status="completed",
        created=created,
        updated=updated,
        restored=restored,
        skipped=skipped,
        errors=0,
        duration_ms=duration_ms,
        result_entry_ids=result_ids,
    )
    batch.status = "completed"
    batch.executed_at = _now()
    batch.execution_summary = summary.model_dump(mode="json")
    batch.version += 1
    all_rows = list(
        (
            await session.execute(
                select(DirectoryImportRow)
                .where(DirectoryImportRow.batch_id == batch.id)
                .order_by(DirectoryImportRow.sort_order, DirectoryImportRow.id)
                .with_for_update()
            )
        )
        .scalars()
        .all()
    )
    for row in all_rows:
        if row.execution_status == "pending":
            row.execution_status = "skipped"
        row.raw_cells = {}
        row.normalized_data = {}
        row.match_candidates = []
        row.match_reasons = []
        row.update_fields = []
    await record_audit_event(
        session,
        event_type="directory_import_completed",
        category="directory",
        action="execute",
        status="success",
        actor=actor,
        target_type="directory_import_batch",
        target_id=batch.id,
        target_label=None,
        details={
            "batch_id": str(batch.id),
            "create": created,
            "update": updated,
            "restore": restored,
            "skip": skipped,
            "duration_ms": duration_ms,
        },
        request=request,
    )
    await session.flush()
    return summary


async def mark_directory_import_execution_failed(
    session: AsyncSession,
    batch_id: UUID,
    *,
    actor: User,
    request: Request | None,
) -> None:
    batch = await _lock_batch(session, batch_id, actor)
    if batch.status == "completed":
        return
    if batch.status != "reconciled":
        raise DirectoryImportValidationError(
            "Only a rolled-back reconciled import can be marked failed",
            code="invalid_state",
        )
    batch.status = "failed"
    batch.execution_error = "execution_failed"
    batch.execution_summary = {
        "batch_id": str(batch.id),
        "status": "failed",
        "created": 0,
        "updated": 0,
        "restored": 0,
        "skipped": 0,
        "errors": 1,
        "duration_ms": 0,
        "result_entry_ids": [],
        "error_code": "execution_failed",
    }
    await record_audit_event(
        session,
        event_type="directory_import_failed",
        category="directory",
        action="execute",
        status="failure",
        actor=actor,
        target_type="directory_import_batch",
        target_id=batch.id,
        target_label=None,
        details={"batch_id": str(batch.id)},
        error_code="execution_failed",
        request=request,
    )
    await session.flush()
