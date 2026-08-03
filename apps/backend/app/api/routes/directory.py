from typing import Annotated, Literal
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query, Request, Response, status
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import get_current_user, get_db, require_can_manage_directory
from app.core.permissions import CAN_MANAGE_DIRECTORY
from app.models.user import User
from app.schemas.directory import (
    DirectoryDepartmentsPublic,
    DirectoryEntryCreate,
    DirectoryEntryPage,
    DirectoryEntryPermanentDelete,
    DirectoryEntryPublic,
    DirectoryEntryUpdate,
)
from app.services.audit import record_audit_event
from app.services.directory import (
    DirectoryEntryNotFoundError,
    DirectoryLinkedUserNotFoundError,
    DirectoryPermanentDeleteError,
    DirectoryStateConflictError,
    create_directory_entry,
    get_directory_entry,
    list_departments,
    list_directory_entries,
    permanently_delete_directory_entry,
    set_directory_entry_active,
    update_directory_entry,
)
from app.services.permissions import has_permission

router = APIRouter()


def directory_http_error(exc: Exception) -> HTTPException:
    if isinstance(exc, DirectoryEntryNotFoundError):
        return HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Directory entry not found")
    if isinstance(exc, DirectoryLinkedUserNotFoundError):
        return HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="Linked user not found")
    if isinstance(exc, DirectoryStateConflictError):
        return HTTPException(status_code=status.HTTP_409_CONFLICT, detail=str(exc))
    return HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Directory operation failed")


async def can_manage_directory(session: AsyncSession, user: User) -> bool:
    return await has_permission(session, user, CAN_MANAGE_DIRECTORY)


def permanent_delete_http_error(exc: DirectoryPermanentDeleteError) -> HTTPException:
    statuses = {
        "directory_entry_delete_forbidden": status.HTTP_403_FORBIDDEN,
        "directory_entry_not_found": status.HTTP_404_NOT_FOUND,
        "directory_entry_must_be_archived": status.HTTP_409_CONFLICT,
        "directory_entry_linked_user": status.HTTP_409_CONFLICT,
        "directory_entry_stale": status.HTTP_409_CONFLICT,
        "confirmation_name_mismatch": status.HTTP_422_UNPROCESSABLE_ENTITY,
    }
    return HTTPException(
        status_code=statuses.get(exc.code, status.HTTP_400_BAD_REQUEST),
        detail=exc.code,
    )


@router.get("", response_model=DirectoryEntryPage)
async def get_directory_entries(
    session: Annotated[AsyncSession, Depends(get_db)],
    current_user: Annotated[User, Depends(get_current_user)],
    search: str | None = Query(default=None, max_length=200),
    department: str | None = Query(default=None, max_length=160),
    status_filter: Annotated[
        Literal["active", "all", "archived"], Query(alias="status")
    ] = "active",
    page: Annotated[int, Query(ge=1)] = 1,
    limit: Annotated[int, Query(ge=1, le=100)] = 30,
) -> DirectoryEntryPage:
    manager = await can_manage_directory(session, current_user)
    if status_filter != "active" and not manager:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Permission required")
    rows, total = await list_directory_entries(
        session,
        search=search,
        department=department,
        include_inactive=status_filter != "active",
        only_inactive=status_filter == "archived",
        page=page,
        limit=limit,
    )
    return DirectoryEntryPage(
        items=[DirectoryEntryPublic.model_validate(row) for row in rows],
        total=total,
        page=page,
        limit=limit,
    )


@router.get("/departments", response_model=DirectoryDepartmentsPublic)
async def get_directory_departments(
    session: Annotated[AsyncSession, Depends(get_db)],
    current_user: Annotated[User, Depends(get_current_user)],
    include_inactive: bool = False,
) -> DirectoryDepartmentsPublic:
    if include_inactive and not await can_manage_directory(session, current_user):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Permission required")
    return DirectoryDepartmentsPublic(
        items=await list_departments(session, include_inactive=include_inactive)
    )


@router.get("/{entry_id}", response_model=DirectoryEntryPublic)
async def get_directory_entry_route(
    entry_id: UUID,
    session: Annotated[AsyncSession, Depends(get_db)],
    current_user: Annotated[User, Depends(get_current_user)],
) -> DirectoryEntryPublic:
    try:
        entry = await get_directory_entry(
            session,
            entry_id,
            include_inactive=await can_manage_directory(session, current_user),
        )
        return DirectoryEntryPublic.model_validate(entry)
    except Exception as exc:
        raise directory_http_error(exc) from exc


@router.post("", response_model=DirectoryEntryPublic, status_code=status.HTTP_201_CREATED)
async def post_directory_entry(
    payload: DirectoryEntryCreate,
    request: Request,
    session: Annotated[AsyncSession, Depends(get_db)],
    current_user: Annotated[User, Depends(require_can_manage_directory)],
) -> DirectoryEntryPublic:
    try:
        entry = await create_directory_entry(session, payload, current_user)
        await record_audit_event(
            session,
            event_type="directory_entry_created",
            category="directory",
            action="create",
            status="success",
            actor=current_user,
            target_type="directory_entry",
            target_id=entry.id,
            target_label=entry.display_name,
            details={
                "is_active": entry.is_active,
                "linked_user_id": str(entry.linked_user_id) if entry.linked_user_id else None,
            },
            request=request,
        )
        response = DirectoryEntryPublic.model_validate(entry)
        await session.commit()
        return response
    except Exception as exc:
        await session.rollback()
        raise directory_http_error(exc) from exc


@router.patch("/{entry_id}", response_model=DirectoryEntryPublic)
async def patch_directory_entry(
    entry_id: UUID,
    payload: DirectoryEntryUpdate,
    request: Request,
    session: Annotated[AsyncSession, Depends(get_db)],
    current_user: Annotated[User, Depends(require_can_manage_directory)],
) -> DirectoryEntryPublic:
    try:
        entry = await get_directory_entry(
            session,
            entry_id,
            include_inactive=True,
            for_update=True,
        )
        updated, changed_fields = await update_directory_entry(session, entry, payload, current_user)
        if changed_fields:
            audit_details: dict[str, object] = {"changed_fields": changed_fields}
            if "linked_user_id" in changed_fields:
                audit_details["linked_user_id"] = (
                    str(updated.linked_user_id) if updated.linked_user_id else None
                )
            await record_audit_event(
                session,
                event_type="directory_entry_updated",
                category="directory",
                action="update",
                status="success",
                actor=current_user,
                target_type="directory_entry",
                target_id=updated.id,
                target_label=updated.display_name,
                details=audit_details,
                request=request,
            )
        response = DirectoryEntryPublic.model_validate(updated)
        await session.commit()
        return response
    except Exception as exc:
        await session.rollback()
        raise directory_http_error(exc) from exc


@router.post("/{entry_id}/archive", response_model=DirectoryEntryPublic)
async def post_directory_entry_archive(
    entry_id: UUID,
    request: Request,
    session: Annotated[AsyncSession, Depends(get_db)],
    current_user: Annotated[User, Depends(require_can_manage_directory)],
) -> DirectoryEntryPublic:
    try:
        entry = await get_directory_entry(
            session,
            entry_id,
            include_inactive=True,
            for_update=True,
        )
        archived = await set_directory_entry_active(session, entry, current_user, is_active=False)
        await record_audit_event(
            session,
            event_type="directory_entry_archived",
            category="directory",
            action="archive",
            status="success",
            actor=current_user,
            target_type="directory_entry",
            target_id=archived.id,
            target_label=archived.display_name,
            details={"changed_fields": ["is_active"]},
            request=request,
        )
        response = DirectoryEntryPublic.model_validate(archived)
        await session.commit()
        return response
    except Exception as exc:
        await session.rollback()
        raise directory_http_error(exc) from exc


@router.post("/{entry_id}/restore", response_model=DirectoryEntryPublic)
async def post_directory_entry_restore(
    entry_id: UUID,
    request: Request,
    session: Annotated[AsyncSession, Depends(get_db)],
    current_user: Annotated[User, Depends(require_can_manage_directory)],
) -> DirectoryEntryPublic:
    try:
        entry = await get_directory_entry(
            session,
            entry_id,
            include_inactive=True,
            for_update=True,
        )
        restored = await set_directory_entry_active(session, entry, current_user, is_active=True)
        await record_audit_event(
            session,
            event_type="directory_entry_restored",
            category="directory",
            action="restore",
            status="success",
            actor=current_user,
            target_type="directory_entry",
            target_id=restored.id,
            target_label=restored.display_name,
            details={"changed_fields": ["is_active"]},
            request=request,
        )
        response = DirectoryEntryPublic.model_validate(restored)
        await session.commit()
        return response
    except Exception as exc:
        await session.rollback()
        raise directory_http_error(exc) from exc


@router.post("/{entry_id}/delete-permanently", status_code=status.HTTP_204_NO_CONTENT)
async def post_directory_entry_delete_permanently(
    entry_id: UUID,
    payload: DirectoryEntryPermanentDelete,
    request: Request,
    session: Annotated[AsyncSession, Depends(get_db)],
    current_user: Annotated[User, Depends(get_current_user)],
) -> Response:
    try:
        await permanently_delete_directory_entry(
            session,
            entry_id,
            payload,
            current_user,
            request,
        )
        await session.commit()
        return Response(status_code=status.HTTP_204_NO_CONTENT)
    except DirectoryPermanentDeleteError as exc:
        await session.rollback()
        raise permanent_delete_http_error(exc) from exc
    except IntegrityError as exc:
        await session.rollback()
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="directory_entry_delete_restricted",
        ) from exc
    except Exception:
        await session.rollback()
        raise
