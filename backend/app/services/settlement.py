from __future__ import annotations

from collections import defaultdict
from dataclasses import dataclass
from datetime import datetime, timedelta

from sqlalchemy import func, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import get_settings
from app.db.models.device import Device
from app.db.models.job import ClusterLease, Job, JobStatus
from app.db.models.payout import Payout, PayoutLedgerEntry, PayoutStatus
from app.db.models.user import User
from app.db.models.wallet import Wallet, WalletEntry, WalletEntryKind
from app.db.models.workunit import WorkUnit, WorkUnitAttempt, WorkUnitStatus
from app.db.session import transactional
from app.exceptions import NotFoundError
from app.logging_setup import get_logger
from app.utils.ids import new_ulid, payout_handle
from app.utils.money import apply_bps, split_pool
from app.utils.time import utcnow


log = get_logger("settlement")


@dataclass(slots=True)
class JobSettlementSummary:
    job_id: str
    pool_cents: int
    platform_fee_cents: int
    paid_to_users_cents: int
    user_count: int
    device_count: int
    workunit_count: int


class SettlementEngine:
    def __init__(self) -> None:
        self.settings = get_settings()

    async def finalize_job(self, session: AsyncSession, job_id: str) -> JobSettlementSummary:
        async with transactional(session):
            job = await session.get(Job, job_id, with_for_update=True)
            if job is None:
                raise NotFoundError("job not found")

            # Recount succeeded workunits from the source of truth (DB) — the
            # counter on Job is best-effort and isn't bumped on every consensus
            # event yet.
            succeeded_count = (await session.execute(
                select(func.count(WorkUnit.id)).where(
                    WorkUnit.job_id == job.id,
                    WorkUnit.status == WorkUnitStatus.succeeded,
                )
            )).scalar_one() or 0
            failed_count = (await session.execute(
                select(func.count(WorkUnit.id)).where(
                    WorkUnit.job_id == job.id,
                    WorkUnit.status.in_(
                        (WorkUnitStatus.failed, WorkUnitStatus.consensus_failed, WorkUnitStatus.timed_out)
                    ),
                )
            )).scalar_one() or 0
            job.workunit_completed = int(succeeded_count)
            job.workunit_failed = int(failed_count)

            if job.status not in (JobStatus.succeeded, JobStatus.failed, JobStatus.timed_out, JobStatus.cancelled):
                job.finished_at = utcnow()
                if succeeded_count >= job.workunit_total > 0:
                    job.status = JobStatus.succeeded
                elif succeeded_count > 0:
                    # partial success — still treat as succeeded for billing
                    job.status = JobStatus.succeeded
                else:
                    job.status = JobStatus.failed

            leases = list((await session.execute(
                select(ClusterLease).where(ClusterLease.job_id == job.id)
            )).scalars())

            # If a lease is still open we close it now and bill it for elapsed
            # wall-clock at the agreed rate. This makes finalize idempotent and
            # works even if release_lease wasn't called separately.
            now = utcnow()
            for lease in leases:
                if lease.is_open or lease.billed_cents == 0:
                    end_ts = lease.ended_at or now
                    elapsed = max(0.0, (end_ts - lease.started_at).total_seconds())
                    lease.runtime_seconds = int(elapsed)
                    hours = elapsed / 3600.0
                    lease.billed_cents = max(1, int(round(lease.rate_usd_per_hour * hours * 100)))
                    if lease.is_open:
                        lease.is_open = False
                        lease.ended_at = now

            gross_cents = sum(lease.billed_cents for lease in leases)
            platform_fee = apply_bps(gross_cents, self.settings.pricing_platform_fee_bps)
            holdback = apply_bps(gross_cents, self.settings.settlement_pool_holdback_bps)
            pool = max(0, gross_cents - platform_fee - holdback)

            attempts = list((await session.execute(
                select(WorkUnitAttempt)
                .join(WorkUnit, WorkUnit.id == WorkUnitAttempt.workunit_id)
                .where(
                    WorkUnit.job_id == job.id,
                    WorkUnitAttempt.accepted.is_(True),
                )
            )).scalars())

            if not attempts or pool <= 0:
                job.spent_cents = gross_cents
                job.platform_fee_cents = platform_fee
                job.paid_to_users_cents = 0
                return JobSettlementSummary(
                    job_id=job.id,
                    pool_cents=pool,
                    platform_fee_cents=platform_fee,
                    paid_to_users_cents=0,
                    user_count=0,
                    device_count=0,
                    workunit_count=0,
                )

            device_weights: dict[str, float] = defaultdict(float)
            unit_runtime: dict[str, float] = {}
            for a in attempts:
                weight = max(a.runtime_ms or 0, 1) / 1000.0
                device_weights[a.device_id] += weight
                unit_runtime.setdefault(a.workunit_id, 0)

            device_ids = list(device_weights.keys())
            devices = (await session.execute(
                select(Device).where(Device.id.in_(device_ids))
            )).scalars().all()
            device_map = {d.id: d for d in devices}

            ordered = list(device_weights.items())
            weights_for_split = [w * device_map[did].reliability_score for did, w in ordered]
            shares = split_pool(pool, weights_for_split)

            user_payouts: dict[str, int] = defaultdict(int)
            now = utcnow()

            for (device_id, _), cents in zip(ordered, shares, strict=True):
                if cents <= 0:
                    continue
                device = device_map.get(device_id)
                if device is None:
                    continue
                user_payouts[device.owner_id] += cents

                entry = PayoutLedgerEntry(
                    id=new_ulid(),
                    user_id=device.owner_id,
                    device_id=device_id,
                    job_id=job.id,
                    amount_cents=cents,
                    weight=device_weights[device_id],
                    occurred_at=now,
                    is_finalized=True,
                    note=f"job:{job.handle}",
                )
                session.add(entry)

                device.revenue_cents_lifetime += cents

            await self._credit_wallets(session, user_payouts)

            paid_to_users = sum(user_payouts.values())
            job.spent_cents = gross_cents
            job.platform_fee_cents = platform_fee
            job.paid_to_users_cents = paid_to_users

            log.info(
                "job.settled",
                job_id=job.id,
                gross_cents=gross_cents,
                platform_fee=platform_fee,
                paid_to_users=paid_to_users,
                user_count=len(user_payouts),
                device_count=len(device_weights),
            )

            return JobSettlementSummary(
                job_id=job.id,
                pool_cents=pool,
                platform_fee_cents=platform_fee,
                paid_to_users_cents=paid_to_users,
                user_count=len(user_payouts),
                device_count=len(device_weights),
                workunit_count=len(unit_runtime),
            )

    async def _credit_wallets(
        self, session: AsyncSession, user_payouts: dict[str, int]
    ) -> None:
        if not user_payouts:
            return
        now = utcnow()
        wallets = (await session.execute(
            select(Wallet).where(Wallet.user_id.in_(user_payouts.keys())).with_for_update()
        )).scalars().all()
        existing = {w.user_id: w for w in wallets}

        for user_id, cents in user_payouts.items():
            wallet = existing.get(user_id)
            if wallet is None:
                wallet = Wallet(id=new_ulid(), user_id=user_id)
                session.add(wallet)
                await session.flush()
            wallet.available_cents += cents
            wallet.lifetime_earned_cents += cents
            wallet.last_activity_at = now

            session.add(WalletEntry(
                id=new_ulid(),
                wallet_id=wallet.id,
                kind=WalletEntryKind.earning,
                amount_cents=cents,
                balance_after_cents=wallet.available_cents,
                occurred_at=now,
                description="job earnings",
            ))

    async def open_payout_for_user(
        self, session: AsyncSession, *, user_id: str, period_start: datetime, period_end: datetime
    ) -> Payout | None:
        async with transactional(session):
            user = await session.get(User, user_id)
            if user is None:
                raise NotFoundError("user not found")
            wallet = (await session.execute(
                select(Wallet).where(Wallet.user_id == user.id).with_for_update()
            )).scalar_one_or_none()
            if wallet is None or wallet.available_cents < self.settings.settlement_min_payout_cents:
                return None

            amount = wallet.available_cents

            payout = Payout(
                id=new_ulid(),
                handle=payout_handle(),
                user_id=user.id,
                amount_cents=amount,
                currency="USD",
                status=PayoutStatus.pending,
                period_start=period_start,
                period_end=period_end,
                method=user.payout_method or "stripe",
            )
            session.add(payout)

            wallet.available_cents -= amount
            wallet.held_cents += amount
            wallet.last_activity_at = utcnow()
            session.add(WalletEntry(
                id=new_ulid(),
                wallet_id=wallet.id,
                kind=WalletEntryKind.payout,
                amount_cents=-amount,
                balance_after_cents=wallet.available_cents,
                occurred_at=utcnow(),
                reference_type="payout",
                reference_id=payout.id,
                description="payout requested",
            ))

            await session.execute(
                update(PayoutLedgerEntry)
                .where(
                    PayoutLedgerEntry.user_id == user.id,
                    PayoutLedgerEntry.payout_id.is_(None),
                    PayoutLedgerEntry.is_finalized.is_(True),
                )
                .values(payout_id=payout.id)
            )

            return payout

    async def mark_payout_paid(
        self, session: AsyncSession, *, payout_id: str, external_id: str
    ) -> None:
        async with transactional(session):
            payout = await session.get(Payout, payout_id, with_for_update=True)
            if payout is None:
                raise NotFoundError("payout not found")
            payout.status = PayoutStatus.paid
            payout.external_id = external_id
            payout.settled_at = utcnow()

            wallet = (await session.execute(
                select(Wallet).where(Wallet.user_id == payout.user_id).with_for_update()
            )).scalar_one_or_none()
            if wallet is not None:
                wallet.held_cents = max(0, wallet.held_cents - payout.amount_cents)
                wallet.lifetime_paid_cents += payout.amount_cents

    async def mark_payout_failed(
        self, session: AsyncSession, *, payout_id: str, reason: str
    ) -> None:
        async with transactional(session):
            payout = await session.get(Payout, payout_id, with_for_update=True)
            if payout is None:
                raise NotFoundError("payout not found")
            payout.status = PayoutStatus.failed
            payout.failure_reason = reason

            wallet = (await session.execute(
                select(Wallet).where(Wallet.user_id == payout.user_id).with_for_update()
            )).scalar_one_or_none()
            if wallet is not None:
                wallet.held_cents = max(0, wallet.held_cents - payout.amount_cents)
                wallet.available_cents += payout.amount_cents
                session.add(WalletEntry(
                    id=new_ulid(),
                    wallet_id=wallet.id,
                    kind=WalletEntryKind.adjustment,
                    amount_cents=payout.amount_cents,
                    balance_after_cents=wallet.available_cents,
                    occurred_at=utcnow(),
                    reference_type="payout",
                    reference_id=payout.id,
                    description=f"payout failed: {reason[:200]}",
                ))


async def estimate_user_24h_earnings(session: AsyncSession, user_id: str) -> int:
    cutoff = utcnow() - timedelta(hours=24)
    stmt = select(func.coalesce(func.sum(PayoutLedgerEntry.amount_cents), 0)).where(
        PayoutLedgerEntry.user_id == user_id,
        PayoutLedgerEntry.occurred_at >= cutoff,
    )
    return int((await session.execute(stmt)).scalar_one() or 0)
