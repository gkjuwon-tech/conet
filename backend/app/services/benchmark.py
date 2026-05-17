from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Final

from app.db.models.device import DeviceClass
from app.schemas.device import DeviceBenchmarkSubmit


H100_REFERENCE_GFLOPS_FP16: Final[float] = 989_000.0
H100_REFERENCE_HASH_MHS_SHA256: Final[float] = 38_000.0
H100_REFERENCE_NETWORK_MBPS: Final[float] = 25_000.0
H100_REFERENCE_RAM_MB: Final[float] = 80_000.0


CLASS_BASELINE: dict[DeviceClass, "ClassBaseline"] = {}


@dataclass(slots=True, frozen=True)
class ClassBaseline:
    device_class: DeviceClass
    expected_cpu_gflops: float
    expected_gpu_gflops: float
    expected_hash_mhs: float
    expected_network_mbps: float
    typical_idle_hours: float
    sanity_cap_gflops: float
    sanity_cap_hash_mhs: float


def _bl(*args: object, **kwargs: object) -> ClassBaseline:
    return ClassBaseline(*args, **kwargs)  # type: ignore[arg-type]


CLASS_BASELINE[DeviceClass.smart_bulb] = _bl(
    device_class=DeviceClass.smart_bulb,
    expected_cpu_gflops=0.04,
    expected_gpu_gflops=0.0,
    expected_hash_mhs=0.0008,
    expected_network_mbps=4.0,
    typical_idle_hours=22.0,
    sanity_cap_gflops=0.5,
    sanity_cap_hash_mhs=0.05,
)
CLASS_BASELINE[DeviceClass.smart_plug] = _bl(
    DeviceClass.smart_plug, 0.05, 0.0, 0.001, 4.0, 22.0, 0.6, 0.06
)
CLASS_BASELINE[DeviceClass.smart_tv] = _bl(
    DeviceClass.smart_tv, 8.0, 12.0, 18.0, 80.0, 16.0, 80.0, 200.0
)
CLASS_BASELINE[DeviceClass.fridge] = _bl(
    DeviceClass.fridge, 0.4, 0.0, 0.4, 10.0, 23.5, 4.0, 4.0
)
CLASS_BASELINE[DeviceClass.washer] = _bl(
    DeviceClass.washer, 0.2, 0.0, 0.15, 5.0, 22.0, 2.0, 2.0
)
CLASS_BASELINE[DeviceClass.dryer] = _bl(
    DeviceClass.dryer, 0.2, 0.0, 0.15, 5.0, 22.0, 2.0, 2.0
)
CLASS_BASELINE[DeviceClass.microwave] = _bl(
    DeviceClass.microwave, 0.1, 0.0, 0.05, 4.0, 23.5, 1.0, 1.0
)
CLASS_BASELINE[DeviceClass.router] = _bl(
    DeviceClass.router, 1.5, 0.0, 4.0, 600.0, 24.0, 12.0, 40.0
)
CLASS_BASELINE[DeviceClass.nas] = _bl(
    DeviceClass.nas, 12.0, 0.0, 30.0, 800.0, 24.0, 80.0, 250.0
)
CLASS_BASELINE[DeviceClass.desktop] = _bl(
    DeviceClass.desktop, 200.0, 6_000.0, 800.0, 600.0, 12.0, 80_000.0, 150_000.0
)
CLASS_BASELINE[DeviceClass.laptop] = _bl(
    DeviceClass.laptop, 90.0, 1_500.0, 200.0, 250.0, 14.0, 8_000.0, 6_000.0
)
CLASS_BASELINE[DeviceClass.console] = _bl(
    DeviceClass.console, 80.0, 10_000.0, 700.0, 600.0, 16.0, 30_000.0, 8_000.0
)
CLASS_BASELINE[DeviceClass.phone] = _bl(
    DeviceClass.phone, 35.0, 200.0, 80.0, 200.0, 16.0, 1_500.0, 1_000.0
)
CLASS_BASELINE[DeviceClass.tablet] = _bl(
    DeviceClass.tablet, 40.0, 250.0, 90.0, 300.0, 18.0, 1_500.0, 1_000.0
)
CLASS_BASELINE[DeviceClass.gpu_rig] = _bl(
    DeviceClass.gpu_rig, 400.0, 50_000.0, 6_000.0, 1_000.0, 22.0, 800_000.0, 800_000.0
)
CLASS_BASELINE[DeviceClass.other_iot] = _bl(
    DeviceClass.other_iot, 0.5, 0.0, 0.3, 8.0, 22.0, 5.0, 8.0
)


@dataclass(slots=True)
class BenchmarkOutcome:
    h100_equivalent: float
    sanitized: DeviceBenchmarkSubmit
    anomalies: list[str]
    confidence: float


def sanitize_and_score(
    submission: DeviceBenchmarkSubmit,
    device_class: DeviceClass,
    historical_h100eq: float | None = None,
) -> BenchmarkOutcome:
    baseline = CLASS_BASELINE.get(device_class) or CLASS_BASELINE[DeviceClass.other_iot]
    anomalies: list[str] = []

    cpu_gflops = min(submission.cpu_gflops, baseline.sanity_cap_gflops * 1.5)
    gpu_gflops = min(submission.gpu_gflops, baseline.sanity_cap_gflops * 4.0)
    hash_mhs = min(submission.hash_mhs_sha256, baseline.sanity_cap_hash_mhs * 1.5)

    if cpu_gflops < submission.cpu_gflops * 0.999:
        anomalies.append("cpu_gflops_capped")
    if gpu_gflops < submission.gpu_gflops * 0.999:
        anomalies.append("gpu_gflops_capped")
    if hash_mhs < submission.hash_mhs_sha256 * 0.999:
        anomalies.append("hash_capped")

    if submission.network_mbps_down > 10_000:
        anomalies.append("absurd_downlink")
    if submission.network_latency_ms < 0.1:
        anomalies.append("absurd_latency")

    sanitized = submission.model_copy(
        update={
            "cpu_gflops": cpu_gflops,
            "gpu_gflops": gpu_gflops,
            "hash_mhs_sha256": hash_mhs,
        }
    )

    h100eq = h100_equivalent(sanitized)

    confidence = 1.0
    if anomalies:
        confidence -= 0.05 * len(anomalies)
    if historical_h100eq is not None and historical_h100eq > 0:
        ratio = h100eq / historical_h100eq if historical_h100eq else 1.0
        if ratio > 3.0 or ratio < 0.3:
            anomalies.append("history_drift")
            confidence -= 0.2
    confidence = max(0.0, min(1.0, confidence))

    return BenchmarkOutcome(
        h100_equivalent=h100eq,
        sanitized=sanitized,
        anomalies=anomalies,
        confidence=confidence,
    )


def h100_equivalent(s: DeviceBenchmarkSubmit) -> float:
    compute_share = (s.cpu_gflops + s.gpu_gflops) / H100_REFERENCE_GFLOPS_FP16
    hash_share = s.hash_mhs_sha256 / H100_REFERENCE_HASH_MHS_SHA256
    network_share = min(s.network_mbps_down, s.network_mbps_up) / H100_REFERENCE_NETWORK_MBPS
    ram_share = (s.ram_mb / H100_REFERENCE_RAM_MB) if s.ram_mb else 0.0

    weighted = (
        0.55 * compute_share
        + 0.25 * hash_share
        + 0.10 * network_share
        + 0.10 * ram_share
    )

    idle_factor = max(0.0, min(1.0, s.avg_idle_hours_per_day / 16.0))
    return round(weighted * (0.4 + 0.6 * idle_factor), 6)


def cluster_h100_equivalent(member_eqs: list[float]) -> float:
    if not member_eqs:
        return 0.0
    return round(math.fsum(member_eqs), 6)


def reliability_floor(idle_hours: float, last_seen_seconds: float) -> float:
    base = max(0.0, min(1.0, idle_hours / 24.0))
    decay = math.exp(-last_seen_seconds / (60 * 60 * 6))
    return round(0.3 * base + 0.7 * decay, 4)
