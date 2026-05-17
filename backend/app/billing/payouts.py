from __future__ import annotations

from datetime import datetime, timedelta

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.billing.stripe_adapter import StripeAdapter
from app.db.models.payout import Payout, PayoutStatus
from app.db.models.user import User
from app.db.session import transactional
from app.logging_setup import get_logger
from app.services.settlement import SettlementEngine
from app.utils.time import utcnow


log = get_logger("billing.payouts")


class PayoutWorker:
    def __init__(self) -> None:
        self.stripe = StripeAdapter()
        self.engine = SettlementEngine()

    async def process_pending(self, session: AsyncSession, *, limit: int = 100) -> dict:
        rows = (await session.execute(
            select(Payout)
            .where(Payout.status == PayoutStatus.pending)
            .limit(limit)
        )).scalars().all()

        succeeded = 0
        failed = 0
        skipped = 0

        for payout in rows:
            user = await session.get(User, payout.user_id)
            if user is None or not user.stripe_account_id:
                await self.engine.mark_payout_failed(
                    session, payout_id=payout.id, reason="user has no payout account"
                )
                failed += 1
                continue

            try:
                async with transactional(session):
                    payout.status = PayoutStatus.processing
                    payout.initiated_at = utcnow()
                result = await self.stripe.transfer_to_user(
                    stripe_account_id=user.stripe_account_id,
                    amount_cents=payout.amount_cents,
                    description=f"ElectroMesh payout {payout.handle}",
                    idempotency_key=payout.id,
                )
                if result.status in ("succeeded", "paid", "pending"):
                    await self.engine.mark_payout_paid(
                        session, payout_id=payout.id, external_id=result.external_id
                    )
                    succeeded += 1
                else:
                    await self.engine.mark_payout_failed(
                        session, payout_id=payout.id, reason=f"transfer status: {result.status}"
                    )
                    failed += 1
            except Exception as exc:
                log.exception("payout.failed", payout_id=payout.id, error=str(exc))
                await self.engine.mark_payout_failed(
                    session, payout_id=payout.id, reason=str(exc)[:480]
                )
                failed += 1

        return {"succeeded": succeeded, "failed": failed, "skipped": skipped, "scanned": len(rows)}


async def open_weekly_payouts(session: AsyncSession, *, min_balance_cents: int = 100) -> int:
    from app.db.models.wallet import Wallet

    period_end = utcnow()
    period_start = period_end - timedelta(days=7)

    rows = (await session.execute(
        select(Wallet).where(Wallet.available_cents >= min_balance_cents)
    )).scalars().all()

    engine = SettlementEngine()
    opened = 0
    for w in rows:
        payout = await engine.open_payout_for_user(
            session, user_id=w.user_id, period_start=period_start, period_end=period_end
        )
        if payout:
            opened += 1
    return opened
