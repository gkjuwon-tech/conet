from __future__ import annotations

from datetime import timedelta

from fastapi import APIRouter, Depends, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.dependencies import Principal, require_user
from app.db.models.payout import Payout, PayoutLedgerEntry
from app.db.session import get_session
from app.exceptions import ConflictError, NotFoundError
from app.schemas.payout import (
    LedgerEntryPublic,
    PayoutPage,
    PayoutPublic,
    PayoutRequest,
)
from app.services.settlement import SettlementEngine
from app.utils.time import utcnow


router = APIRouter(prefix="/payouts", tags=["payouts"])


@router.get("", response_model=PayoutPage)
async def list_payouts(
    principal: Principal = Depends(require_user),
    session: AsyncSession = Depends(get_session),
    cursor: str | None = None,
    limit: int = 50,
) -> PayoutPage:
    stmt = (
        select(Payout)
        .where(Payout.user_id == principal.user.id)
        .order_by(Payout.created_at.desc())
        .limit(limit + 1)
    )
    if cursor:
        stmt = stmt.where(Payout.created_at < cursor)
    rows = (await session.execute(stmt)).scalars().all()
    items = rows[:limit]
    next_cursor = items[-1].created_at.isoformat() if len(rows) > limit else None
    return PayoutPage(items=[PayoutPublic.model_validate(p) for p in items], next_cursor=next_cursor)


@router.get("/{payout_id}", response_model=PayoutPublic)
async def get_payout(
    payout_id: str,
    principal: Principal = Depends(require_user),
    session: AsyncSession = Depends(get_session),
) -> PayoutPublic:
    payout = await session.get(Payout, payout_id)
    if payout is None:
        raise NotFoundError("payout not found").as_http()
    if payout.user_id != principal.user.id and not principal.is_admin:
        from app.exceptions import PermissionError_
        raise PermissionError_("not your payout").as_http()
    return PayoutPublic.model_validate(payout)


@router.get("/{payout_id}/ledger", response_model=list[LedgerEntryPublic])
async def payout_ledger(
    payout_id: str,
    principal: Principal = Depends(require_user),
    session: AsyncSession = Depends(get_session),
) -> list[LedgerEntryPublic]:
    payout = await session.get(Payout, payout_id)
    if payout is None:
        raise NotFoundError("payout not found").as_http()
    if payout.user_id != principal.user.id and not principal.is_admin:
        from app.exceptions import PermissionError_
        raise PermissionError_("not your payout").as_http()

    rows = (await session.execute(
        select(PayoutLedgerEntry).where(PayoutLedgerEntry.payout_id == payout_id)
        .order_by(PayoutLedgerEntry.occurred_at.asc())
    )).scalars().all()
    return [LedgerEntryPublic.model_validate(r) for r in rows]


@router.post("/request", response_model=PayoutPublic, status_code=status.HTTP_201_CREATED)
async def request_payout(
    payload: PayoutRequest,
    principal: Principal = Depends(require_user),
    session: AsyncSession = Depends(get_session),
) -> PayoutPublic:
    if not payload.confirm:
        raise ConflictError("confirm flag required").as_http()
    engine = SettlementEngine()
    now = utcnow()
    payout = await engine.open_payout_for_user(
        session, user_id=principal.user.id, period_start=now - timedelta(days=7), period_end=now
    )
    if payout is None:
        raise ConflictError("balance below minimum payout threshold").as_http()
    return PayoutPublic.model_validate(payout)
