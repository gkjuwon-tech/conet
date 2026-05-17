from __future__ import annotations

import asyncio
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone

from sqlalchemy import func, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import get_settings
from app.db.models.cluster import Cluster, ClusterMembership, ClusterStatus
from app.db.models.device import Device, DeviceStatus
from app.db.session import transactional
from app.exceptions import InsufficientCapacity
from app.logging_setup import get_logger
from app.services.pricing import contribution_from_device, price_cluster
from app.utils.ids import cluster_handle, new_ulid
from app.utils.time import utcnow


log = get_logger("bundling")


@dataclass(slots=True)
class BundleResult:
    cluster_id: str
    cluster_handle: str
    sequence_no: int
    member_ids: list[str]
    rate_usd_per_hour: float
    h100_equivalent: float


class FCFSBundler:
    """Strict first-come-first-served bundler.

    Pulls eligible idle devices in arrival order (queued_at) and packs them into
    fixed-size virtual clusters. Each cluster is priced individually based on the
    actual mix of devices captured.
    """

    def __init__(self, *, target_size: int | None = None, max_age_seconds: int | None = None) -> None:
        settings = get_settings()
        self.target_size = target_size or settings.bundling_size
        self.max_age_seconds = max_age_seconds or settings.bundling_max_age_seconds
        self.min_score = settings.bundling_min_score
        self._lock = asyncio.Lock()

    async def run_once(self, session: AsyncSession) -> list[BundleResult]:
        async with self._lock:
            return await self._tick(session)

    async def _tick(self, session: AsyncSession) -> list[BundleResult]:
        results: list[BundleResult] = []
        async with transactional(session):
            cutoff = utcnow() - timedelta(seconds=self.max_age_seconds)

            stmt = (
                select(Device)
                .where(
                    Device.status == DeviceStatus.idle,
                    Device.h100_equivalent > 0,
                    Device.reliability_score >= self.min_score,
                    Device.auto_join_enabled.is_(True),
                )
                .order_by(Device.last_seen_at.nullsfirst(), Device.created_at)
                .limit(self.target_size * 12)
                .with_for_update(skip_locked=True)
            )
            devices = list((await session.execute(stmt)).scalars())

            if not devices:
                return results

            buffer: list[Device] = []
            forced_flush_idx: int | None = None
            for d in devices:
                buffer.append(d)
                age_anchor = d.last_seen_at or d.created_at
                if age_anchor and age_anchor.replace(tzinfo=timezone.utc) < cutoff and forced_flush_idx is None:
                    forced_flush_idx = len(buffer) - 1

                if len(buffer) >= self.target_size:
                    cluster = await self._materialize(session, buffer)
                    results.append(cluster)
                    buffer = []
                    forced_flush_idx = None

            if buffer and forced_flush_idx is not None and len(buffer) >= max(2, self.target_size // 4):
                cluster = await self._materialize(session, buffer)
                results.append(cluster)

        return results

    async def _materialize(self, session: AsyncSession, devices: list[Device]) -> BundleResult:
        if not devices:
            raise InsufficientCapacity("no devices to bundle")

        seq_stmt = select(func.coalesce(func.max(Cluster.sequence_no), 0))
        next_seq = (await session.execute(seq_stmt)).scalar_one() + 1

        contributions = [contribution_from_device(d) for d in devices]
        price = price_cluster(contributions, redundancy=get_settings().workunit_redundancy)

        cluster = Cluster(
            id=new_ulid(),
            handle=cluster_handle(),
            sequence_no=next_seq,
            status=ClusterStatus.available,
            member_count=len(devices),
            target_size=self.target_size,
            aggregate_cpu_gflops=sum(d.cpu_gflops for d in devices),
            aggregate_gpu_gflops=sum(d.gpu_gflops for d in devices),
            aggregate_ram_mb=sum(d.ram_mb for d in devices),
            aggregate_vram_mb=sum(d.gpu_vram_mb for d in devices),
            aggregate_storage_gb=sum(d.storage_gb for d in devices),
            aggregate_hash_mhs_sha256=sum(d.hash_mhs_sha256 for d in devices),
            aggregate_network_mbps=sum(min(d.network_mbps_down, d.network_mbps_up) for d in devices),
            h100_equivalent=price.h100_equivalent,
            reliability_score=price.reliability_score,
            trust_score=price.trust_score,
            diversity_index=price.diversity_index,
            price_usd_per_hour=price.total_usd_hour,
            price_breakdown=_dump(price),
            capability_summary=price.capability_summary,
            composition=price.composition,
            formed_at=utcnow(),
            available_at=utcnow(),
        )
        session.add(cluster)
        await session.flush()

        memberships = [
            ClusterMembership(
                id=new_ulid(),
                cluster_id=cluster.id,
                device_id=d.id,
                weight=max(d.h100_equivalent, 1e-6),
                joined_at=utcnow(),
                snapshot={
                    "device_class": d.device_class.value,
                    "h100_equivalent": d.h100_equivalent,
                    "hash_mhs_sha256": d.hash_mhs_sha256,
                    "cpu_gflops": d.cpu_gflops,
                    "gpu_gflops": d.gpu_gflops,
                    "ram_mb": d.ram_mb,
                    "reliability_score": d.reliability_score,
                    "trust_score": d.trust_score,
                },
            )
            for d in devices
        ]
        session.add_all(memberships)

        await session.execute(
            update(Device)
            .where(Device.id.in_([d.id for d in devices]))
            .values(status=DeviceStatus.leased)
        )

        log.info(
            "cluster.formed",
            cluster_id=cluster.id,
            sequence_no=next_seq,
            members=len(devices),
            h100_equivalent=price.h100_equivalent,
            rate_usd_hour=price.total_usd_hour,
        )

        return BundleResult(
            cluster_id=cluster.id,
            cluster_handle=cluster.handle,
            sequence_no=next_seq,
            member_ids=[d.id for d in devices],
            rate_usd_per_hour=price.total_usd_hour,
            h100_equivalent=price.h100_equivalent,
        )


def _dump(price: object) -> dict:
    return {
        k: getattr(price, k)
        for k in (
            "base_compute_usd_hour",
            "network_uplift_usd_hour",
            "reliability_uplift_usd_hour",
            "diversity_discount_usd_hour",
            "redundancy_overhead_usd_hour",
            "platform_fee_usd_hour",
            "payout_pool_usd_hour",
            "total_usd_hour",
        )
    }


async def retire_stale_clusters(session: AsyncSession, *, max_idle_minutes: int = 30) -> int:
    cutoff = utcnow() - timedelta(minutes=max_idle_minutes)
    stmt = (
        select(Cluster)
        .where(
            Cluster.status == ClusterStatus.available,
            Cluster.available_at < cutoff,
        )
        .with_for_update(skip_locked=True)
    )
    rows = list((await session.execute(stmt)).scalars())
    count = 0
    for c in rows:
        c.status = ClusterStatus.retired
        c.retired_at = utcnow()
        count += 1
        await session.execute(
            update(Device)
            .where(
                Device.id.in_(
                    select(ClusterMembership.device_id).where(
                        ClusterMembership.cluster_id == c.id,
                        ClusterMembership.is_active.is_(True),
                    )
                )
            )
            .values(status=DeviceStatus.idle)
        )
    return count
