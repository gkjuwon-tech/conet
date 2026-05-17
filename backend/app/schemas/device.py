from __future__ import annotations

from datetime import datetime
from typing import Any

from pydantic import BaseModel, ConfigDict, Field

from app.db.models.device import DeviceClass, DeviceStatus


class DeviceConsents(BaseModel):
    compute_share: bool = True
    network_share: bool = True
    storage_share: bool = False
    night_only: bool = False
    max_cpu_pct: int = Field(default=10, ge=0, le=100)
    max_gpu_pct: int = Field(default=10, ge=0, le=100)
    max_bandwidth_mbps: float = Field(default=2.0, ge=0)
    blackout_hours: list[int] = Field(default_factory=list)


class DeviceCapabilities(BaseModel):
    sha256: bool = True
    argon2: bool = False
    ml_inference: bool = False
    fhe: bool = False
    mpc: bool = False
    render: bool = False
    secure_enclave: bool = False
    tpm: bool = False


class DeviceRegister(BaseModel):
    model_config = ConfigDict(str_strip_whitespace=True)

    label: str | None = Field(default=None, max_length=120)
    device_class: DeviceClass
    vendor: str | None = Field(default=None, max_length=80)
    model: str | None = Field(default=None, max_length=120)
    firmware: str | None = Field(default=None, max_length=80)
    os: str | None = Field(default=None, max_length=40)
    arch: str | None = Field(default=None, max_length=40)
    public_key: str | None = Field(default=None, max_length=512)
    consents: DeviceConsents = Field(default_factory=DeviceConsents)
    capabilities: DeviceCapabilities = Field(default_factory=DeviceCapabilities)
    lan_fingerprint: str | None = Field(default=None, max_length=64)


class DeviceBenchmarkSubmit(BaseModel):
    cpu_cores: int = Field(ge=0, le=512)
    cpu_ghz: float = Field(ge=0, le=10)
    ram_mb: int = Field(ge=0)
    storage_gb: int = Field(ge=0)
    gpu_model: str | None = Field(default=None, max_length=80)
    gpu_vram_mb: int = Field(default=0, ge=0)

    cpu_gflops: float = Field(ge=0)
    gpu_gflops: float = Field(default=0, ge=0)
    hash_mhs_sha256: float = Field(ge=0)
    hash_mhs_argon2: float = Field(default=0, ge=0)
    network_mbps_down: float = Field(ge=0)
    network_mbps_up: float = Field(ge=0)
    network_latency_ms: float = Field(ge=0)
    avg_idle_hours_per_day: float = Field(default=0, ge=0, le=24)

    proof: str | None = Field(default=None, max_length=2048)


class DevicePublic(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: str
    handle: str
    label: str | None
    device_class: DeviceClass
    status: DeviceStatus
    vendor: str | None
    model: str | None
    h100_equivalent: float
    reliability_score: float
    trust_score: float
    contribution_score: float
    revenue_cents_lifetime: int
    workunits_completed: int
    last_seen_at: datetime | None
    last_benchmark_at: datetime | None
    auto_join_enabled: bool


class DeviceDetail(DevicePublic):
    cpu_cores: int
    cpu_ghz: float
    ram_mb: int
    storage_gb: int
    gpu_model: str | None
    gpu_vram_mb: int
    cpu_gflops: float
    gpu_gflops: float
    hash_mhs_sha256: float
    hash_mhs_argon2: float
    network_mbps_down: float
    network_mbps_up: float
    network_latency_ms: float
    consents: dict[str, Any]
    capabilities: dict[str, Any]


class DeviceUpdate(BaseModel):
    label: str | None = None
    auto_join_enabled: bool | None = None
    consents: DeviceConsents | None = None


class DeviceHeartbeat(BaseModel):
    cpu_usage_pct: float = Field(ge=0, le=100)
    gpu_usage_pct: float = Field(default=0, ge=0, le=100)
    ram_usage_pct: float = Field(default=0, ge=0, le=100)
    temperature_c: float | None = None
    power_watts: float | None = None
    rssi_dbm: float | None = None
    download_mbps: float | None = None
    upload_mbps: float | None = None
    extras: dict[str, Any] = Field(default_factory=dict)


class DeviceClaim(BaseModel):
    device_id: str
    pairing_code: str = Field(min_length=6, max_length=12)
