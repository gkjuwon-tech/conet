from __future__ import annotations

import hashlib
import json
from collections import defaultdict
from dataclasses import dataclass
from datetime import timedelta
from typing import Any

from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import get_settings
from app.db.models.cluster import Cluster, ClusterMembership, ClusterStatus
from app.db.models.device import Device, DeviceStatus
from app.db.models.job import ClusterLease, Job, JobKind, JobStatus
from app.db.models.workunit import WorkUnit, WorkUnitAttempt, WorkUnitStatus
from app.db.session import transactional
from app.exceptions import InsufficientCapacity, NotFoundError, WorkunitRejected
from app.logging_setup import get_logger
from app.utils.ids import new_ulid, workunit_handle
from app.utils.time import utcnow


log = get_logger("dispatcher")


@dataclass(slots=True)
class DispatchedUnit:
    workunit_id: str
    handle: str
    device_id: str
    payload: dict[str, Any]
    expected_runtime_seconds: int


@dataclass(slots=True)
class ConsensusOutcome:
    workunit_id: str
    achieved: bool
    winning_hash: str | None
    score: float
    accepted_attempts: list[str]
    rejected_attempts: list[str]


class JobDispatcher:
    def __init__(self) -> None:
        self.settings = get_settings()

    async def lease_clusters_for_job(self, session: AsyncSession, job: Job) -> list[ClusterLease]:
        async with transactional(session):
            stmt = (
                select(Cluster)
                .where(
                    Cluster.status == ClusterStatus.available,
                    Cluster.is_listed.is_(True),
                )
                .order_by(Cluster.h100_equivalent.desc())
                .with_for_update(skip_locked=True)
                .limit(job.target_cluster_count * 4)
            )
            candidates = list((await session.execute(stmt)).scalars())

            chosen: list[Cluster] = []
            accumulated = 0.0
            target = job.target_h100_equivalent
            for c in candidates:
                if len(chosen) >= job.target_cluster_count and accumulated >= target:
                    break
                # Skip clusters that would overshoot the budget — UNLESS we
                # haven't hit `target_cluster_count` yet. This is what lets
                # a "spread me across 16 devices" job actually pull in the
                # lowest-h100 devices instead of grabbing one beefy cluster
                # and stopping early.
                if (
                    accumulated + c.h100_equivalent > target * 1.5
                    and accumulated >= target
                    and len(chosen) >= job.target_cluster_count
                ):
                    continue
                chosen.append(c)
                accumulated += c.h100_equivalent

            if accumulated < target * 0.5 or not chosen:
                raise InsufficientCapacity(
                    "no clusters meet target capacity",
                    detail={
                        "target_h100": target,
                        "available_h100": accumulated,
                        "candidates": len(candidates),
                    },
                )

            now = utcnow()
            leases: list[ClusterLease] = []
            for c in chosen:
                lease = ClusterLease(
                    id=new_ulid(),
                    cluster_id=c.id,
                    job_id=job.id,
                    started_at=now,
                    expected_end_at=now + timedelta(seconds=job.max_runtime_seconds),
                    rate_usd_per_hour=c.price_usd_per_hour,
                )
                session.add(lease)
                c.status = ClusterStatus.leased
                c.leased_at = now
                leases.append(lease)

            job.status = JobStatus.running
            job.started_at = now
            job.deadline_at = now + timedelta(seconds=job.max_runtime_seconds)

            return leases

    async def release_lease(self, session: AsyncSession, lease: ClusterLease, *, billed_cents: int) -> None:
        async with transactional(session):
            cluster = await session.get(Cluster, lease.cluster_id)
            now = utcnow()
            lease.ended_at = now
            lease.is_open = False
            lease.runtime_seconds = int((now - lease.started_at).total_seconds())
            lease.billed_cents = billed_cents
            if cluster:
                cluster.status = ClusterStatus.draining
                await session.execute(
                    update(Device)
                    .where(
                        Device.id.in_(
                            select(ClusterMembership.device_id).where(
                                ClusterMembership.cluster_id == cluster.id
                            )
                        )
                    )
                    .values(status=DeviceStatus.cooldown)
                )

    async def claim_next_unit(
        self, session: AsyncSession, *, device: Device, max_units: int = 1
    ) -> list[DispatchedUnit]:
        if device.status not in (DeviceStatus.leased, DeviceStatus.idle):
            return []

        async with transactional(session):
            cluster_stmt = (
                select(ClusterMembership.cluster_id)
                .where(
                    ClusterMembership.device_id == device.id,
                    ClusterMembership.is_active.is_(True),
                )
                .limit(1)
            )
            cluster_id = (await session.execute(cluster_stmt)).scalar_one_or_none()
            if cluster_id is None:
                return []

            lease_stmt = (
                select(ClusterLease)
                .where(
                    ClusterLease.cluster_id == cluster_id,
                    ClusterLease.is_open.is_(True),
                )
                .order_by(ClusterLease.started_at.desc())
                .limit(1)
            )
            lease = (await session.execute(lease_stmt)).scalar_one_or_none()
            if lease is None:
                return []

            already = (
                await session.execute(
                    select(WorkUnitAttempt.workunit_id).where(
                        WorkUnitAttempt.device_id == device.id,
                        WorkUnitAttempt.status.in_(
                            (WorkUnitStatus.dispatched, WorkUnitStatus.in_flight)
                        ),
                    )
                )
            ).scalars().all()
            already_set = set(already)

            unit_stmt = (
                select(WorkUnit)
                .where(
                    WorkUnit.job_id == lease.job_id,
                    WorkUnit.status.in_((WorkUnitStatus.pending, WorkUnitStatus.consensus_pending)),
                    WorkUnit.redundancy_satisfied < WorkUnit.redundancy_required,
                )
                .order_by(WorkUnit.sequence_no)
                .limit(max_units * 4)
                .with_for_update(skip_locked=True)
            )
            candidates = list((await session.execute(unit_stmt)).scalars())
            chosen: list[WorkUnit] = []
            for u in candidates:
                if u.id in already_set:
                    continue
                chosen.append(u)
                if len(chosen) >= max_units:
                    break

            now = utcnow()
            dispatched: list[DispatchedUnit] = []
            for unit in chosen:
                attempt_no = (
                    await session.execute(
                        select(WorkUnitAttempt)
                        .where(WorkUnitAttempt.workunit_id == unit.id)
                        .order_by(WorkUnitAttempt.attempt_no.desc())
                        .limit(1)
                    )
                ).scalar_one_or_none()
                next_no = (attempt_no.attempt_no + 1) if attempt_no else 1

                attempt = WorkUnitAttempt(
                    id=new_ulid(),
                    workunit_id=unit.id,
                    device_id=device.id,
                    attempt_no=next_no,
                    status=WorkUnitStatus.dispatched,
                    started_at=now,
                )
                session.add(attempt)

                if unit.status == WorkUnitStatus.pending:
                    unit.status = WorkUnitStatus.dispatched
                if unit.dispatched_at is None:
                    unit.dispatched_at = now
                if unit.deadline_at is None:
                    unit.deadline_at = now + timedelta(
                        seconds=max(unit.expected_runtime_seconds * 2, 60)
                    )

                dispatched.append(
                    DispatchedUnit(
                        workunit_id=unit.id,
                        handle=unit.handle,
                        device_id=device.id,
                        payload=unit.payload,
                        expected_runtime_seconds=unit.expected_runtime_seconds,
                    )
                )

            return dispatched

    async def submit_result(
        self,
        session: AsyncSession,
        *,
        device: Device,
        workunit_id: str,
        runtime_ms: int,
        result: dict[str, Any],
        result_hash: str,
        proof: str | None,
        error_code: str | None,
        error_message: str | None,
    ) -> ConsensusOutcome:
        async with transactional(session):
            workunit = await session.get(WorkUnit, workunit_id, with_for_update=True)
            if workunit is None:
                raise NotFoundError("workunit not found")

            attempt_stmt = (
                select(WorkUnitAttempt)
                .where(
                    WorkUnitAttempt.workunit_id == workunit_id,
                    WorkUnitAttempt.device_id == device.id,
                    WorkUnitAttempt.status.in_(
                        (WorkUnitStatus.dispatched, WorkUnitStatus.in_flight)
                    ),
                )
                .order_by(WorkUnitAttempt.attempt_no.desc())
                .limit(1)
                .with_for_update()
            )
            attempt = (await session.execute(attempt_stmt)).scalar_one_or_none()
            if attempt is None:
                raise WorkunitRejected("no live attempt for device on this workunit")

            now = utcnow()
            attempt.completed_at = now
            attempt.runtime_ms = runtime_ms
            attempt.result = result
            attempt.result_hash = result_hash
            attempt.proof = proof
            attempt.error_code = error_code
            attempt.error_message = error_message

            if error_code:
                attempt.status = WorkUnitStatus.failed
                workunit.status = (
                    WorkUnitStatus.consensus_pending
                    if workunit.redundancy_satisfied < workunit.redundancy_required
                    else WorkUnitStatus.failed
                )
                return ConsensusOutcome(
                    workunit_id=workunit_id,
                    achieved=False,
                    winning_hash=None,
                    score=0.0,
                    accepted_attempts=[],
                    rejected_attempts=[attempt.id],
                )

            attempt.status = WorkUnitStatus.succeeded
            workunit.redundancy_satisfied += 1

            # Flush so the SELECT inside _evaluate_consensus sees the just-saved
            # attempt (autoflush is disabled on this session).
            await session.flush()
            return await self._evaluate_consensus(session, workunit)

    async def _evaluate_consensus(
        self, session: AsyncSession, workunit: WorkUnit
    ) -> ConsensusOutcome:
        attempts_stmt = (
            select(WorkUnitAttempt)
            .where(
                WorkUnitAttempt.workunit_id == workunit.id,
                WorkUnitAttempt.status == WorkUnitStatus.succeeded,
            )
        )
        attempts = list((await session.execute(attempts_stmt)).scalars())

        if len(attempts) < workunit.redundancy_required:
            workunit.status = WorkUnitStatus.consensus_pending
            return ConsensusOutcome(
                workunit_id=workunit.id,
                achieved=False,
                winning_hash=None,
                score=0.0,
                accepted_attempts=[],
                rejected_attempts=[],
            )

        groups: dict[str, list[WorkUnitAttempt]] = defaultdict(list)
        for a in attempts:
            if a.result_hash:
                groups[a.result_hash].append(a)

        winning_hash, winning_group = max(
            groups.items(), key=lambda kv: len(kv[1])
        ) if groups else (None, [])

        score = (len(winning_group) / max(len(attempts), 1)) if winning_group else 0.0
        threshold = self.settings.fraud_consensus_threshold
        achieved = score >= threshold

        accepted = [a.id for a in winning_group] if achieved else []
        rejected = [a.id for a in attempts if a.id not in accepted]

        if achieved:
            workunit.status = WorkUnitStatus.succeeded
            workunit.completed_at = utcnow()
            workunit.consensus_score = score
            workunit.final_result_hash = winning_hash
            workunit.final_result = winning_group[0].result
            for a in winning_group:
                a.accepted = True
        else:
            workunit.status = WorkUnitStatus.consensus_failed

        return ConsensusOutcome(
            workunit_id=workunit.id,
            achieved=achieved,
            winning_hash=winning_hash,
            score=score,
            accepted_attempts=accepted,
            rejected_attempts=rejected,
        )


def hash_result(result: dict[str, Any]) -> str:
    return hashlib.sha256(
        json.dumps(result, sort_keys=True, separators=(",", ":")).encode("utf-8")
    ).hexdigest()
