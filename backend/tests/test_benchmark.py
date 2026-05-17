from __future__ import annotations

from app.db.models.device import DeviceClass
from app.schemas.device import DeviceBenchmarkSubmit
from app.services.benchmark import sanitize_and_score


def _submit(**overrides) -> DeviceBenchmarkSubmit:  # type: ignore[no-untyped-def]
    base = dict(
        cpu_cores=8,
        cpu_ghz=3.5,
        ram_mb=16_000,
        storage_gb=512,
        gpu_model="RTX 4070",
        gpu_vram_mb=12_000,
        cpu_gflops=300.0,
        gpu_gflops=20_000.0,
        hash_mhs_sha256=2_000.0,
        hash_mhs_argon2=20.0,
        network_mbps_down=500.0,
        network_mbps_up=200.0,
        network_latency_ms=15.0,
        avg_idle_hours_per_day=12.0,
    )
    base.update(overrides)
    return DeviceBenchmarkSubmit(**base)


def test_score_desktop_reasonable() -> None:
    out = sanitize_and_score(_submit(), DeviceClass.desktop)
    assert 0.005 < out.h100_equivalent < 0.5


def test_score_smart_bulb_capped() -> None:
    out = sanitize_and_score(
        _submit(
            cpu_gflops=999_999,
            gpu_gflops=999_999,
            hash_mhs_sha256=999_999,
            ram_mb=64,
            storage_gb=0,
            gpu_vram_mb=0,
            avg_idle_hours_per_day=23,
        ),
        DeviceClass.smart_bulb,
    )
    assert "cpu_gflops_capped" in out.anomalies
    assert "gpu_gflops_capped" in out.anomalies
    assert "hash_capped" in out.anomalies


def test_history_drift_lowers_confidence() -> None:
    out = sanitize_and_score(
        _submit(cpu_gflops=20.0, gpu_gflops=0.0, hash_mhs_sha256=10.0),
        DeviceClass.desktop,
        historical_h100eq=0.4,
    )
    assert "history_drift" in out.anomalies
    assert out.confidence < 0.85
