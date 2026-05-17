from __future__ import annotations

from fastapi import APIRouter, Depends, Query
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.dependencies import Principal, get_principal
from app.db.models import Cluster, ClusterMembership, Device
from app.db.session import get_session
from app.exceptions import NotFoundError
from app.schemas.cluster import (
    ClusterCard,
    ClusterDetail,
    ClusterMemberCard,
    ClusterPriceBreakdown,
)
from app.services.bundling import FCFSBundler

router = APIRouter(prefix="/clusters", tags=["clusters"])


@router.get("", response_model=list[ClusterCard])
async def list_clusters(
    status_filter: str | None = Query(default=None, alias="status"),
    limit: int = Query(default=50, ge=1, le=200),
    session: AsyncSession = Depends(get_session),
    _: Principal = Depends(get_principal),
) -> list[ClusterCard]:
    stmt = select(Cluster).order_by(Cluster.sequence_no.desc()).limit(limit)
    if status_filter:
        stmt = stmt.where(Cluster.status == status_filter)
    rows = (await session.execute(stmt)).scalars().all()
    return [ClusterCard.model_validate(c) for c in rows]


@router.get("/{cluster_id}", response_model=ClusterDetail)
async def cluster_detail(
    cluster_id: str,
    session: AsyncSession = Depends(get_session),
    _: Principal = Depends(get_principal),
) -> ClusterDetail:
    cluster = await session.get(Cluster, cluster_id)
    if cluster is None:
        raise NotFoundError("cluster not found").as_http()

    members = (await session.execute(
        select(ClusterMembership, Device)
        .join(Device, Device.id == ClusterMembership.device_id)
        .where(ClusterMembership.cluster_id == cluster_id, ClusterMembership.is_active.is_(True))
    )).all()

    member_cards = [
        ClusterMemberCard(
            device_id=d.id,
            device_class=d.device_class,
            h100_equivalent=d.h100_equivalent,
            weight=m.weight,
            reliability_score=d.reliability_score,
            trust_score=d.trust_score,
        )
        for m, d in members
    ]

    breakdown = None
    if cluster.price_breakdown:
        breakdown = ClusterPriceBreakdown(**cluster.price_breakdown)

    detail = ClusterDetail.model_validate(cluster)
    detail = detail.model_copy(update={"price_breakdown": breakdown, "members": member_cards})
    return detail


@router.post("/_bundle", response_model=list[ClusterCard])
async def trigger_bundle(
    session: AsyncSession = Depends(get_session),
    principal: Principal = Depends(get_principal),
) -> list[ClusterCard]:
    if not principal.is_admin:
        from app.exceptions import PermissionError_
        raise PermissionError_("admin only").as_http()
    bundler = FCFSBundler()
    results = await bundler.run_once(session)
    if not results:
        return []

    cluster_ids = [r.cluster_id for r in results]
    rows = (await session.execute(
        select(Cluster).where(Cluster.id.in_(cluster_ids))
    )).scalars().all()
    return [ClusterCard.model_validate(c) for c in rows]
