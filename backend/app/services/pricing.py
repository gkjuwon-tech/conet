from __future__ import annotations

import math
from collections import Counter
from dataclasses import dataclass, field

from app.config import get_settings
from app.db.models.cluster import Cluster
from app.db.models.device import Device, DeviceClass


@dataclass(slots=True)
class DeviceContribution:
    device_id: str
    device_class: DeviceClass
    h100_equivalent: float
    reliability_score: float
    trust_score: float
    network_mbps: float


@dataclass(slots=True)
class ClusterPrice:
    base_compute_usd_hour: float
    network_uplift_usd_hour: float
    reliability_uplift_usd_hour: float
    diversity_discount_usd_hour: float
    redundancy_overhead_usd_hour: float
    platform_fee_usd_hour: float
    payout_pool_usd_hour: float
    total_usd_hour: float
    h100_equivalent: float
    diversity_index: float
    reliability_score: float
    trust_score: float
    composition: dict[str, int] = field(default_factory=dict)
    capability_summary: dict[str, float] = field(default_factory=dict)


CLASS_PRICE_MULTIPLIER: dict[DeviceClass, float] = {
    DeviceClass.gpu_rig: 1.30,
    DeviceClass.desktop: 1.15,
    DeviceClass.console: 1.10,
    DeviceClass.laptop: 1.00,
    DeviceClass.tablet: 0.90,
    DeviceClass.phone: 0.85,
    DeviceClass.nas: 1.05,
    DeviceClass.smart_tv: 0.95,
    DeviceClass.router: 0.80,
    DeviceClass.fridge: 0.55,
    DeviceClass.washer: 0.55,
    DeviceClass.dryer: 0.55,
    DeviceClass.microwave: 0.50,
    DeviceClass.smart_plug: 0.45,
    DeviceClass.smart_bulb: 0.40,
    DeviceClass.other_iot: 0.55,
}


def price_cluster(
    contributions: list[DeviceContribution],
    *,
    redundancy: int = 2,
) -> ClusterPrice:
    settings = get_settings()
    if not contributions:
        return ClusterPrice(0, 0, 0, 0, 0, 0, 0, settings.pricing_min_cluster_usd_hour, 0, 0, 0, 0)

    h100 = sum(c.h100_equivalent for c in contributions)
    base = h100 * settings.pricing_h100_baseline_usd_hour

    weighted_class_factor = (
        sum(
            CLASS_PRICE_MULTIPLIER.get(c.device_class, 1.0) * max(c.h100_equivalent, 1e-6)
            for c in contributions
        )
        / max(h100, 1e-6)
    )
    base *= weighted_class_factor

    avg_network = sum(c.network_mbps for c in contributions) / len(contributions)
    network_uplift = base * min(0.25, avg_network / 5_000.0)

    avg_rel = sum(c.reliability_score for c in contributions) / len(contributions)
    reliability_uplift = base * (avg_rel - 0.5) * 0.4

    composition = Counter(c.device_class for c in contributions)
    diversity_index = _shannon_entropy(composition)
    diversity_discount = base * min(0.15, diversity_index * 0.05)

    redundancy_overhead = base * (settings.pricing_redundancy_factor - 1.0) * (redundancy / 2.0)

    subtotal = base + network_uplift + reliability_uplift - diversity_discount + redundancy_overhead

    platform_fee = subtotal * (settings.pricing_platform_fee_bps / 10_000.0)
    payout_pool = subtotal - platform_fee

    total = max(subtotal, settings.pricing_min_cluster_usd_hour)

    avg_trust = sum(c.trust_score for c in contributions) / len(contributions)

    capability_summary = {
        "members": float(len(contributions)),
        "avg_network_mbps": round(avg_network, 2),
        "avg_reliability": round(avg_rel, 4),
        "avg_trust": round(avg_trust, 4),
        "avg_class_multiplier": round(weighted_class_factor, 3),
    }

    return ClusterPrice(
        base_compute_usd_hour=round(base, 4),
        network_uplift_usd_hour=round(network_uplift, 4),
        reliability_uplift_usd_hour=round(reliability_uplift, 4),
        diversity_discount_usd_hour=round(diversity_discount, 4),
        redundancy_overhead_usd_hour=round(redundancy_overhead, 4),
        platform_fee_usd_hour=round(platform_fee, 4),
        payout_pool_usd_hour=round(payout_pool, 4),
        total_usd_hour=round(total, 4),
        h100_equivalent=round(h100, 6),
        diversity_index=round(diversity_index, 4),
        reliability_score=round(avg_rel, 4),
        trust_score=round(avg_trust, 4),
        composition={k.value: v for k, v in composition.items()},
        capability_summary=capability_summary,
    )


def _shannon_entropy(counter: Counter) -> float:
    total = sum(counter.values())
    if total == 0:
        return 0.0
    entropy = 0.0
    for count in counter.values():
        p = count / total
        entropy -= p * math.log(p, 2) if p > 0 else 0
    return entropy


def contribution_from_device(device: Device) -> DeviceContribution:
    network = min(device.network_mbps_down, device.network_mbps_up)
    return DeviceContribution(
        device_id=device.id,
        device_class=device.device_class,
        h100_equivalent=device.h100_equivalent,
        reliability_score=device.reliability_score,
        trust_score=device.trust_score,
        network_mbps=network,
    )


def quote_cluster_runtime(cluster: Cluster, hours: float) -> dict[str, float]:
    settings = get_settings()
    rate = max(cluster.price_usd_per_hour, settings.pricing_min_cluster_usd_hour)
    total = rate * hours
    return {
        "rate_usd_per_hour": round(rate, 4),
        "hours": round(hours, 4),
        "total_usd": round(total, 4),
        "expected_h100_hours": round(cluster.h100_equivalent * hours, 4),
        "platform_fee_usd": round(total * (settings.pricing_platform_fee_bps / 10_000.0), 4),
    }
