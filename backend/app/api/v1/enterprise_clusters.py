"""Enterprise cluster endpoints — read-only with masked device details.

Why this exists separately from `/v1/clusters`:
The marketplace endpoint exposes device IDs and verbose composition data
for individual prospectors. Enterprise API keys should never see which
physical device is doing their work — only the aggregate cluster shape
and per-class statistics. This module is the redacted view.
"""

from __future__ import annotations

from datetime import datetime

from fastapi import APIRouter, Depends, Query
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.dependencies import Principal, require_enterprise, require_scope
from app.db.models import Cluster, ClusterMembership, Device
from app.db.models.cluster import ClusterStatus
from app.db.session import get_session
from app.exceptions import NotFoundError
from app.schemas.cluster import ClusterPriceBreakdown

router = APIRouter(prefix="/enterprise/clusters", tags=["enterprise_clusters"])


class EnterpriseClusterCard(BaseModel):
    """Minimal cluster info — no device IDs, no SSH endpoints."""
    model_config = ConfigDict(from_attributes=True)

    id: str
    handle: str
    sequence_no: int
    status: ClusterStatus
    member_count: int
    target_size: int
    h100_equivalent: float
    reliability_score: float
    trust_score: float
    price_usd_per_hour: float
    region_hint: str | None
    available_at: datetime | None


class EnterpriseClusterMemberCard(BaseModel):
    """A cluster member's compute spec — never includes device id, MAC, or IP."""

    device_class: str
    h100_equivalent: float
    weight: float
    reliability_score: float
    trust_score: float


class EnterpriseClusterDetail(EnterpriseClusterCard):
    """Detailed cluster with aggregate stats and member composition (anonymous)."""

    aggregate_cpu_gflops: float
    aggregate_gpu_gflops: float
    aggregate_ram_mb: int
    aggregate_vram_mb: int
    aggregate_hash_mhs_sha256: float
    aggregate_network_mbps: float
    diversity_index: float
    price_breakdown: ClusterPriceBreakdown | None = None
    members: list[EnterpriseClusterMemberCard] = Field(default_factory=list)


@router.get("", response_model=list[EnterpriseClusterCard])
async def list_clusters(
    limit: int = Query(default=50, ge=1, le=200),
    status_filter: str | None = Query(default=None, alias="status"),
    session: AsyncSession = Depends(get_session),
    _: Principal = Depends(require_enterprise),
    __: Principal = Depends(require_scope("clusters:read")),
) -> list[EnterpriseClusterCard]:
    """List clusters in the marketplace, redacted for enterprise consumers."""
    stmt = select(Cluster).order_by(Cluster.sequence_no.desc()).limit(limit)
    if status_filter:
        stmt = stmt.where(Cluster.status == status_filter)
    rows = (await session.execute(stmt)).scalars().all()
    return [EnterpriseClusterCard.model_validate(c) for c in rows]


@router.get("/{cluster_id}", response_model=EnterpriseClusterDetail)
async def cluster_detail(
    cluster_id: str,
    session: AsyncSession = Depends(get_session),
    _: Principal = Depends(require_enterprise),
    __: Principal = Depends(require_scope("clusters:read")),
) -> EnterpriseClusterDetail:
    """Detailed cluster — members visible only as anonymous compute specs."""
    cluster = await session.get(Cluster, cluster_id)
    if cluster is None:
        raise NotFoundError("cluster not found").as_http()

    rows = (await session.execute(
        select(ClusterMembership, Device)
        .join(Device, Device.id == ClusterMembership.device_id)
        .where(
            ClusterMembership.cluster_id == cluster_id,
            ClusterMembership.is_active.is_(True),
        )
    )).all()

    members = [
        EnterpriseClusterMemberCard(
            device_class=d.device_class.value,
            h100_equivalent=d.h100_equivalent,
            weight=m.weight,
            reliability_score=d.reliability_score,
            trust_score=d.trust_score,
        )
        for m, d in rows
    ]

    breakdown = ClusterPriceBreakdown(**cluster.price_breakdown) if cluster.price_breakdown else None

    return EnterpriseClusterDetail.model_validate(cluster).model_copy(
        update={"price_breakdown": breakdown, "members": members}
    )
