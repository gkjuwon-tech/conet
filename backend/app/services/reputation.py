from __future__ import annotations

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.models.device import Device
from app.db.models.workunit import WorkUnitAttempt, WorkUnitStatus
from app.utils.time import utcnow


class ReputationEngine:
    """EWMA-style scoring for reliability and trust."""

    def update_after_attempt(
        self,
        device: Device,
        *,
        accepted: bool,
        runtime_ms: int | None,
        consensus_aligned: bool,
    ) -> None:
        alpha = 0.18
        success_signal = 1.0 if accepted else 0.0

        device.reliability_score = self._ewma(device.reliability_score, success_signal, alpha)

        if accepted:
            trust_signal = 1.0 if consensus_aligned else 0.4
        else:
            trust_signal = 0.1
        device.trust_score = self._ewma(device.trust_score, trust_signal, alpha * 0.7)

        if accepted:
            device.workunits_completed += 1
        else:
            device.workunits_rejected += 1

        if runtime_ms is not None and runtime_ms > 0:
            speed_bonus = max(0.0, min(0.05, 5_000.0 / runtime_ms - 0.05))
            device.contribution_score = round(device.contribution_score + speed_bonus, 4)

        device.last_seen_at = utcnow()

    def _ewma(self, prev: float, sample: float, alpha: float) -> float:
        prev = max(0.0, min(1.0, prev))
        sample = max(0.0, min(1.0, sample))
        return round(prev * (1 - alpha) + sample * alpha, 4)


async def recalculate_device_score_window(
    session: AsyncSession, device_id: str, *, window: int = 200
) -> tuple[float, float]:
    stmt = (
        select(WorkUnitAttempt)
        .where(WorkUnitAttempt.device_id == device_id)
        .order_by(WorkUnitAttempt.started_at.desc())
        .limit(window)
    )
    attempts = list((await session.execute(stmt)).scalars())
    if not attempts:
        return 0.5, 0.5

    success = sum(1 for a in attempts if a.status == WorkUnitStatus.succeeded and a.accepted)
    total = len(attempts)
    success_rate = success / total

    aligned = sum(1 for a in attempts if a.accepted)
    align_rate = aligned / total
    return round(success_rate, 4), round(align_rate, 4)
