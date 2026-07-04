from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import get_current_user, get_db
from app.models.user import User
from app.schemas.unread import DirectReadReceiptPublic, MarkReadRequest, ReadStatePublic, UnreadSummaryPublic
from app.services.unread import get_direct_read_receipt, get_unread_summary, mark_chat_read

router = APIRouter()


@router.get("/unread", response_model=UnreadSummaryPublic)
async def unread_summary(
    session: Annotated[AsyncSession, Depends(get_db)],
    current_user: Annotated[User, Depends(get_current_user)],
) -> UnreadSummaryPublic:
    return await get_unread_summary(session, current_user)


@router.post("/read-state", response_model=ReadStatePublic)
async def post_read_state(
    payload: MarkReadRequest,
    session: Annotated[AsyncSession, Depends(get_db)],
    current_user: Annotated[User, Depends(get_current_user)],
) -> ReadStatePublic:
    try:
        return await mark_chat_read(session, current_user, payload)
    except LookupError as exc:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=str(exc)) from exc
    except PermissionError as exc:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail=str(exc)) from exc


@router.get(
    "/read-state/direct/{conversation_id}/receipt",
    response_model=DirectReadReceiptPublic,
)
async def direct_read_receipt(
    conversation_id: UUID,
    session: Annotated[AsyncSession, Depends(get_db)],
    current_user: Annotated[User, Depends(get_current_user)],
) -> DirectReadReceiptPublic:
    try:
        return await get_direct_read_receipt(session, current_user, conversation_id)
    except LookupError as exc:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=str(exc)) from exc
    except PermissionError as exc:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail=str(exc)) from exc
