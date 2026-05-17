from __future__ import annotations

import pytest

from app.db.models.device import DeviceClass
from app.services.pricing import DeviceContribution, price_cluster


def _make(c: DeviceClass, h100eq: float, network: float = 200.0, rel: float = 0.8) -> DeviceContribution:
    return DeviceContribution(
        device_id=f"dev-{c.value}",
        device_class=c,
        h100_equivalent=h100eq,
        reliability_score=rel,
        trust_score=rel,
        network_mbps=network,
    )


def test_price_empty_returns_minimum() -> None:
    p = price_cluster([])
    assert p.total_usd_hour > 0
    assert p.h100_equivalent == 0


def test_price_single_gpu_rig_skews_high() -> None:
    p = price_cluster([_make(DeviceClass.gpu_rig, 0.5)])
    assert p.total_usd_hour > 0.5
    assert p.composition["gpu_rig"] == 1


def test_diversity_discount_applied() -> None:
    homogeneous = price_cluster([_make(DeviceClass.desktop, 0.05) for _ in range(8)])
    diverse = price_cluster([
        _make(DeviceClass.desktop, 0.05),
        _make(DeviceClass.laptop, 0.04),
        _make(DeviceClass.console, 0.06),
        _make(DeviceClass.smart_tv, 0.01),
        _make(DeviceClass.fridge, 0.005),
        _make(DeviceClass.router, 0.003),
        _make(DeviceClass.smart_bulb, 0.001),
        _make(DeviceClass.nas, 0.04),
    ])
    assert diverse.diversity_index > homogeneous.diversity_index


def test_reliability_uplift_increases_price() -> None:
    low = price_cluster([_make(DeviceClass.desktop, 0.05, rel=0.4) for _ in range(5)])
    high = price_cluster([_make(DeviceClass.desktop, 0.05, rel=0.95) for _ in range(5)])
    assert high.total_usd_hour > low.total_usd_hour


def test_platform_fee_takes_share() -> None:
    p = price_cluster([_make(DeviceClass.desktop, 0.1) for _ in range(4)])
    assert p.platform_fee_usd_hour > 0
    assert p.payout_pool_usd_hour > 0
    assert pytest.approx(p.platform_fee_usd_hour + p.payout_pool_usd_hour, rel=0.05) == (
        p.base_compute_usd_hour
        + p.network_uplift_usd_hour
        + p.reliability_uplift_usd_hour
        - p.diversity_discount_usd_hour
        + p.redundancy_overhead_usd_hour
    )


def test_unique_pricing_per_composition() -> None:
    a = price_cluster([_make(DeviceClass.gpu_rig, 0.3), _make(DeviceClass.smart_bulb, 0.001)])
    b = price_cluster([_make(DeviceClass.gpu_rig, 0.3), _make(DeviceClass.gpu_rig, 0.3)])
    assert a.total_usd_hour != b.total_usd_hour
