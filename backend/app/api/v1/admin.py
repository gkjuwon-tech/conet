from __future__ import annotations

from fastapi import APIRouter, Depends
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.dependencies import Principal, require_admin
from app.db.models import Cluster, Device, Job, Payout, User, WorkUnit
from app.db.models.cluster import ClusterStatus
from app.db.models.device import DeviceStatus
from app.db.models.job import JobStatus
from app.db.session import get_session
from app.exceptions import NotFoundError
from app.services.bundling import FCFSBundler, retire_stale_clusters
from app.services.fraud import FraudEngine
from app.services.heartbeat import reap_offline_devices
from app.services.settlement import SettlementEngine

router = APIRouter(prefix="/admin", tags=["admin"])


@router.get("/health")
async def health() -> dict:
    return {"status": "ok"}


@router.get("/stats", dependencies=[Depends(require_admin)])
async def global_stats(session: AsyncSession = Depends(get_session)) -> dict:
    user_count = (await session.execute(select(func.count(User.id)))).scalar_one() or 0
    device_count = (await session.execute(select(func.count(Device.id)))).scalar_one() or 0
    online_devices = (await session.execute(
        select(func.count(Device.id)).where(
            Device.status.in_((DeviceStatus.idle, DeviceStatus.leased))
        )
    )).scalar_one() or 0
    cluster_count = (await session.execute(
        select(func.count(Cluster.id)).where(Cluster.status == ClusterStatus.available)
    )).scalar_one() or 0
    leased = (await session.execute(
        select(func.count(Cluster.id)).where(Cluster.status == ClusterStatus.leased)
    )).scalar_one() or 0
    jobs_running = (await session.execute(
        select(func.count(Job.id)).where(Job.status == JobStatus.running)
    )).scalar_one() or 0
    workunits_pending = (await session.execute(
        select(func.count(WorkUnit.id)).where(WorkUnit.completed_at.is_(None))
    )).scalar_one() or 0
    h100_total = (await session.execute(
        select(func.coalesce(func.sum(Cluster.h100_equivalent), 0)).where(
            Cluster.status.in_((ClusterStatus.available, ClusterStatus.leased))
        )
    )).scalar_one() or 0
    return {
        "users": int(user_count),
        "devices": int(device_count),
        "devices_online": int(online_devices),
        "clusters_available": int(cluster_count),
        "clusters_leased": int(leased),
        "jobs_running": int(jobs_running),
        "workunits_pending": int(workunits_pending),
        "h100_equivalent_active": float(h100_total),
    }


@router.post("/run/bundler", dependencies=[Depends(require_admin)])
async def run_bundler(session: AsyncSession = Depends(get_session)) -> dict:
    bundler = FCFSBundler()
    results = await bundler.run_once(session)
    retired = await retire_stale_clusters(session)
    await session.commit()
    return {"bundled": len(results), "retired": retired}


@router.post("/run/reap", dependencies=[Depends(require_admin)])
async def run_reap(session: AsyncSession = Depends(get_session)) -> dict:
    n = await reap_offline_devices(session)
    await session.commit()
    return {"offline_marked": n}


@router.post("/run/settle/{job_id}", dependencies=[Depends(require_admin)])
async def force_settle(
    job_id: str, session: AsyncSession = Depends(get_session)
) -> dict:
    engine = SettlementEngine()
    summary = await engine.finalize_job(session, job_id)
    return summary.__dict__


@router.post("/devices/{device_id}/quarantine", dependencies=[Depends(require_admin)])
async def quarantine(
    device_id: str,
    reason: str,
    session: AsyncSession = Depends(get_session),
) -> dict:
    device = await session.get(Device, device_id, with_for_update=True)
    if device is None:
        raise NotFoundError("device not found").as_http()
    fraud = FraudEngine()
    await fraud.quarantine_device(session, device, reason)
    await session.commit()
    return {"device_id": device_id, "status": device.status.value}


@router.get("/payouts/pending", dependencies=[Depends(require_admin)])
async def list_pending_payouts(
    session: AsyncSession = Depends(get_session),
    limit: int = 200,
) -> list[dict]:
    rows = (await session.execute(
        select(Payout).where(Payout.status == "pending").limit(limit)
    )).scalars().all()
    return [
        {
            "id": p.id,
            "user_id": p.user_id,
            "amount_cents": p.amount_cents,
            "method": p.method,
        }
        for p in rows
    ]
