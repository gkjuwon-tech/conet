from __future__ import annotations

from datetime import datetime
from typing import Any

from pydantic import BaseModel, ConfigDict, Field

from app.db.models.cluster import ClusterStatus
from app.db.models.device import DeviceClass


class ClusterMemberCard(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    device_id: str
    device_class: DeviceClass
    h100_equivalent: float
    weight: float
    reliability_score: float
    trust_score: float


class ClusterPriceBreakdown(BaseModel):
    base_compute_usd_hour: float
    network_uplift_usd_hour: float
    reliability_uplift_usd_hour: float
    diversity_discount_usd_hour: float
    redundancy_overhead_usd_hour: float
    platform_fee_usd_hour: float
    payout_pool_usd_hour: float
    total_usd_hour: float


class ClusterCard(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: str
    handle: str
    sequence_no: int
    status: ClusterStatus

    member_count: int
    target_size: int

    h100_equivalent: float
    aggregate_cpu_gflops: float
    aggregate_gpu_gflops: float
    aggregate_ram_mb: int
    aggregate_vram_mb: int
    aggregate_hash_mhs_sha256: float
    aggregate_network_mbps: float

    reliability_score: float
    trust_score: float
    diversity_index: float

    price_usd_per_hour: float
    region_hint: str | None
    available_at: datetime | None
    composition: dict[str, Any] = Field(default_factory=dict)
    capability_summary: dict[str, Any] = Field(default_factory=dict)


class ClusterDetail(ClusterCard):
    price_breakdown: ClusterPriceBreakdown | None = None
    members: list[ClusterMemberCard] = Field(default_factory=list)


class MarketplaceFilter(BaseModel):
    min_h100_equivalent: float | None = None
    max_h100_equivalent: float | None = None
    min_price_usd_hour: float | None = None
    max_price_usd_hour: float | None = None
    min_reliability: float | None = Field(default=None, ge=0, le=1)
    required_capabilities: list[str] = Field(default_factory=list)
    region_hint: str | None = None
    sort: str = Field(default="price_asc")
    cursor: str | None = None
    limit: int = Field(default=20, ge=1, le=100)


class MarketplacePage(BaseModel):
    items: list[ClusterCard]
    next_cursor: str | None
    total_estimate: int
