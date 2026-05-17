"""Enterprise cluster endpoints — read-only cluster access with masked device details."""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends, Query
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.dependencies import Principal, require_enterprise, require_scope
from app.auth.enterprise_scopes import validate_scopes
from app.db.models import Cluster, ClusterMembership, Device
from app.db.session import get_session
from app.exceptions import NotFoundError
from app.schemas.cluster import ClusterCard, ClusterPriceBreakdown

router = APIRouter(prefix="/enterprise/clusters", tags=["enterprise_clusters"])


class EnterpriseMemberCard:
    """Safe device representation for enterprise API — masks individual device IDs."""

    def __init__(self, device_class: str, h100_equivalent: float, weight: float,
                 reliability_score: float, trust_score: float):
        self.device_class = device_class
        self.h100_equivalent = h100_equivalent
        self.weight = weight
        self.reliability_score = reliability_score
        self.trust_score = trust_score

    def model_dump(self) -> dict[str, Any]:
        return {
            "device_class": self.device_class,
            "h100_equivalent": self.h100_equivalent,
            "weight": self.weight,
            "reliability_score": self.reliability_score,
            "trust_score": self.trust_score,
        }


class EnterpriseClusterCard:
    """Minimal cluster info for enterprise listing."""

    def __init__(self, cluster: Cluster):
        self.id = cluster.id
        self.handle = cluster.handle
        self.sequence_no = cluster.sequence_no
        self.status = cluster.status
        self.member_count = cluster.member_count
        self.target_size = cluster.target_size
        self.h100_equivalent = cluster.h100_equivalent
        self.reliability_score = cluster.reliability_score
        self.trust_score = cluster.trust_score
        self.price_usd_per_hour = cluster.price_usd_per_hour
        self.region_hint = cluster.region_hint
        self.available_at = cluster.available_at

    def model_dump(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "handle": self.handle,
            "sequence_no": self.sequence_no,
            "status": self.status.value,
            "member_count": self.member_count,
            "target_size": self.target_size,
            "h100_equivalent": self.h100_equivalent,
            "reliability_score": self.reliability_score,
            "trust_score": self.trust_score,
            "price_usd_per_hour": self.price_usd_per_hour,
            "region_hint": self.region_hint,
            "available_at": self.available_at.isoformat() if self.available_at else None,
        }


class EnterpriseClusterDetail:
    """Detailed cluster info with masked member details — no device IDs or SSH endpoints."""

    def __init__(self, cluster: Cluster, members: list[EnterpriseMemberCard],
                 price_breakdown: ClusterPriceBreakdown | None):
        self.id = cluster.id
        self.handle = cluster.handle
        self.sequence_no = cluster.sequence_no
        self.status = cluster.status
        self.member_count = cluster.member_count
        self.target_size = cluster.target_size
        self.h100_equivalent = cluster.h100_equivalent
        self.aggregate_cpu_gflops = cluster.aggregate_cpu_gflops
        self.aggregate_gpu_gflops = cluster.aggregate_gpu_gflops
        self.aggregate_ram_mb = cluster.aggregate_ram_mb
        self.aggregate_vram_mb = cluster.aggregate_vram_mb
        self.aggregate_hash_mhs_sha256 = cluster.aggregate_hash_mhs_sha256
        self.aggregate_network_mbps = cluster.aggregate_network_mbps
        self.reliability_score = cluster.reliability_score
        self.trust_score = cluster.trust_score
        self.diversity_index = cluster.diversity_index
        self.price_usd_per_hour = cluster.price_usd_per_hour
        self.region_hint = cluster.region_hint
        self.available_at = cluster.available_at
        self.members = members
        self.price_breakdown = price_breakdown

    def model_dump(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "handle": self.handle,
            "sequence_no": self.sequence_no,
            "status": self.status.value,
            "member_count": self.member_count,
            "target_size": self.target_size,
            "h100_equivalent": self.h100_equivalent,
            "aggregate_cpu_gflops": self.aggregate_cpu_gflops,
            "aggregate_gpu_gflops": self.aggregate_gpu_gflops,
            "aggregate_ram_mb": self.aggregate_ram_mb,
            "aggregate_vram_mb": self.aggregate_vram_mb,
            "aggregate_hash_mhs_sha256": self.aggregate_hash_mhs_sha256,
            "aggregate_network_mbps": self.aggregate_network_mbps,
            "reliability_score": self.reliability_score,
            "trust_score": self.trust_score,
            "diversity_index": self.diversity_index,
            "price_usd_per_hour": self.price_usd_per_hour,
            "region_hint": self.region_hint,
            "available_at": self.available_at.isoformat() if self.available_at else None,
            "price_breakdown": self.price_breakdown.model_dump() if self.price_breakdown else None,
            "members": [m.model_dump() for m in self.members],
        }


@router.get("", response_model=list[dict[str, Any]])
async def list_clusters(
    limit: int = Query(default=50, ge=1, le=200),
    status: str | None = Query(default=None),
    session: AsyncSession = Depends(get_session),
    principal: Principal = Depends(require_enterprise),
    _: Principal = Depends(require_scope("clusters:read")),
) -> list[dict[str, Any]]:
    """List clusters available to this enterprise."""
    stmt = select(Cluster).order_by(Cluster.sequence_no.desc()).limit(limit)
    if status:
        stmt = stmt.where(Cluster.status == status)
    rows = (await session.execute(stmt)).scalars().all()
    return [EnterpriseClusterCard(c).model_dump() for c in rows]


@router.get("/{cluster_id}", response_model=dict[str, Any])
async def cluster_detail(
    cluster_id: str,
    session: AsyncSession = Depends(get_session),
    principal: Principal = Depends(require_enterprise),
    _: Principal = Depends(require_scope("clusters:read")),
) -> dict[str, Any]:
    """Get detailed cluster info with member specs (no device IDs or SSH endpoints)."""
    cluster = await session.get(Cluster, cluster_id)
    if cluster is None:
        raise NotFoundError("cluster not found").as_http()

    members = (await session.execute(
        select(ClusterMembership, Device)
        .join(Device, Device.id == ClusterMembership.device_id)
        .where(ClusterMembership.cluster_id == cluster_id, ClusterMembership.is_active.is_(True))
    )).all()

    member_cards = [
        EnterpriseMemberCard(
            device_class=d.device_class.value,
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

    detail = EnterpriseClusterDetail(cluster, member_cards, breakdown)
    return detail.model_dump()
