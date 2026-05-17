from __future__ import annotations

from collections import Counter
from dataclasses import dataclass

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import get_settings
from app.db.models.device import Device, DeviceStatus
from app.db.models.workunit import WorkUnitAttempt, WorkUnitStatus
from app.exceptions import FraudSuspected
from app.logging_setup import get_logger


log = get_logger("fraud")


@dataclass(slots=True)
class FraudVerdict:
    risky: bool
    reasons: list[str]
    weight_penalty: float


class FraudEngine:
    def __init__(self) -> None:
        self.settings = get_settings()

    async def evaluate_device_registration(
        self, session: AsyncSession, *, owner_id: str, lan_fingerprint: str | None
    ) -> FraudVerdict:
        reasons: list[str] = []
        penalty = 0.0

        owner_count_stmt = select(func.count(Device.id)).where(Device.owner_id == owner_id)
        owner_count = int((await session.execute(owner_count_stmt)).scalar_one() or 0)
        if owner_count >= 24:
            reasons.append("owner_device_cap_exceeded")

        if lan_fingerprint:
            lan_count_stmt = select(func.count(Device.id)).where(
                Device.lan_fingerprint == lan_fingerprint,
                Device.status != DeviceStatus.decommissioned,
            )
            lan_count = int((await session.execute(lan_count_stmt)).scalar_one() or 0)
            if lan_count >= self.settings.fraud_max_devices_per_lan:
                reasons.append("lan_density_high")
                penalty += 0.4

            distinct_owners_stmt = (
                select(func.count(func.distinct(Device.owner_id)))
                .where(Device.lan_fingerprint == lan_fingerprint)
            )
            distinct_owners = int((await session.execute(distinct_owners_stmt)).scalar_one() or 0)
            if distinct_owners > 4:
                reasons.append("lan_multi_owner")
                penalty += 0.2

        return FraudVerdict(risky=bool(reasons), reasons=reasons, weight_penalty=min(penalty, 0.9))

    async def evaluate_attempt_burst(
        self, session: AsyncSession, *, device_id: str, window_minutes: int = 5
    ) -> FraudVerdict:
        from datetime import timedelta

        from app.utils.time import utcnow

        cutoff = utcnow() - timedelta(minutes=window_minutes)
        rows = list((await session.execute(
            select(WorkUnitAttempt).where(
                WorkUnitAttempt.device_id == device_id,
                WorkUnitAttempt.started_at >= cutoff,
            )
        )).scalars())

        reasons: list[str] = []
        penalty = 0.0

        if len(rows) > 200:
            reasons.append("burst_too_fast")
            penalty += 0.3

        statuses = Counter(a.status for a in rows)
        if rows and statuses.get(WorkUnitStatus.failed, 0) / len(rows) > 0.7:
            reasons.append("high_failure_rate")
            penalty += 0.3

        result_hashes = [a.result_hash for a in rows if a.result_hash]
        if len(result_hashes) > 30 and len(set(result_hashes)) <= 3:
            reasons.append("result_hash_collision_unusual")
            penalty += 0.4

        return FraudVerdict(risky=bool(reasons), reasons=reasons, weight_penalty=min(penalty, 1.0))

    async def quarantine_device(self, session: AsyncSession, device: Device, reason: str) -> None:
        device.status = DeviceStatus.quarantined
        device.metadata_ = {**(device.metadata_ or {}), "quarantine_reason": reason}
        log.warning("device.quarantined", device_id=device.id, reason=reason)

    def assert_safe_or_raise(self, verdict: FraudVerdict) -> None:
        if verdict.weight_penalty >= 0.8:
            raise FraudSuspected("device flagged", detail={"reasons": verdict.reasons})
