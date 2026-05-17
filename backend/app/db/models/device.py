from __future__ import annotations

import enum
from datetime import datetime
from typing import TYPE_CHECKING

from sqlalchemy import (
    BigInteger,
    Boolean,
    DateTime,
    Enum,
    Float,
    ForeignKey,
    Index,
    Integer,
    String,
)
from sqlalchemy.dialects.postgresql import INET, JSONB
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db.base import Base
from app.utils.ids import new_ulid

if TYPE_CHECKING:
    from app.db.models.cluster import ClusterMembership
    from app.db.models.user import User
    from app.db.models.workunit import WorkUnitAttempt


class DeviceClass(str, enum.Enum):
    smart_bulb = "smart_bulb"
    smart_plug = "smart_plug"
    smart_tv = "smart_tv"
    fridge = "fridge"
    washer = "washer"
    dryer = "dryer"
    microwave = "microwave"
    router = "router"
    nas = "nas"
    desktop = "desktop"
    laptop = "laptop"
    console = "console"
    phone = "phone"
    tablet = "tablet"
    gpu_rig = "gpu_rig"
    other_iot = "other_iot"


class DeviceStatus(str, enum.Enum):
    pending_attestation = "pending_attestation"
    benchmarking = "benchmarking"
    idle = "idle"
    leased = "leased"
    cooldown = "cooldown"
    offline = "offline"
    quarantined = "quarantined"
    decommissioned = "decommissioned"


class Device(Base):
    __tablename__ = "devices"

    id: Mapped[str] = mapped_column(String(40), primary_key=True, default=new_ulid)
    handle: Mapped[str] = mapped_column(String(64), nullable=False, unique=True)
    owner_id: Mapped[str] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), nullable=False
    )

    label: Mapped[str | None] = mapped_column(String(120))
    device_class: Mapped[DeviceClass] = mapped_column(
        Enum(DeviceClass, name="device_class"), nullable=False
    )
    status: Mapped[DeviceStatus] = mapped_column(
        Enum(DeviceStatus, name="device_status"),
        default=DeviceStatus.pending_attestation,
        nullable=False,
    )

    vendor: Mapped[str | None] = mapped_column(String(80))
    model: Mapped[str | None] = mapped_column(String(120))
    firmware: Mapped[str | None] = mapped_column(String(80))
    os: Mapped[str | None] = mapped_column(String(40))
    arch: Mapped[str | None] = mapped_column(String(40))

    cpu_cores: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    cpu_ghz: Mapped[float] = mapped_column(Float, default=0.0, nullable=False)
    ram_mb: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    storage_gb: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    gpu_model: Mapped[str | None] = mapped_column(String(80))
    gpu_vram_mb: Mapped[int] = mapped_column(Integer, default=0, nullable=False)

    cpu_gflops: Mapped[float] = mapped_column(Float, default=0.0, nullable=False)
    gpu_gflops: Mapped[float] = mapped_column(Float, default=0.0, nullable=False)
    hash_mhs_sha256: Mapped[float] = mapped_column(Float, default=0.0, nullable=False)
    hash_mhs_argon2: Mapped[float] = mapped_column(Float, default=0.0, nullable=False)
    network_mbps_down: Mapped[float] = mapped_column(Float, default=0.0, nullable=False)
    network_mbps_up: Mapped[float] = mapped_column(Float, default=0.0, nullable=False)
    network_latency_ms: Mapped[float] = mapped_column(Float, default=0.0, nullable=False)

    h100_equivalent: Mapped[float] = mapped_column(Float, default=0.0, nullable=False)
    reliability_score: Mapped[float] = mapped_column(Float, default=0.5, nullable=False)
    trust_score: Mapped[float] = mapped_column(Float, default=0.5, nullable=False)
    contribution_score: Mapped[float] = mapped_column(Float, default=0.0, nullable=False)

    avg_idle_hours_per_day: Mapped[float] = mapped_column(Float, default=0.0, nullable=False)
    last_seen_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    last_benchmark_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))

    public_key: Mapped[str | None] = mapped_column(String(512))
    attestation_proof: Mapped[str | None] = mapped_column(String(2048))
    attestation_verified_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))

    lan_fingerprint: Mapped[str | None] = mapped_column(String(64))
    last_ip: Mapped[str | None] = mapped_column(INET)
    user_agent: Mapped[str | None] = mapped_column(String(255))

    revenue_cents_lifetime: Mapped[int] = mapped_column(BigInteger, default=0, nullable=False)
    workunits_completed: Mapped[int] = mapped_column(BigInteger, default=0, nullable=False)
    workunits_rejected: Mapped[int] = mapped_column(BigInteger, default=0, nullable=False)

    consents: Mapped[dict] = mapped_column(JSONB, default=dict, nullable=False)
    capabilities: Mapped[dict] = mapped_column(JSONB, default=dict, nullable=False)
    metadata_: Mapped[dict] = mapped_column("metadata", JSONB, default=dict, nullable=False)

    auto_join_enabled: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)

    owner: Mapped["User"] = relationship(back_populates="devices")
    memberships: Mapped[list["ClusterMembership"]] = relationship(back_populates="device")
    attempts: Mapped[list["WorkUnitAttempt"]] = relationship(back_populates="device")
    telemetry: Mapped[list["DeviceTelemetry"]] = relationship(
        back_populates="device", cascade="all, delete-orphan"
    )

    __table_args__ = (
        Index("ix_devices_owner", "owner_id"),
        Index("ix_devices_status_class", "status", "device_class"),
        Index("ix_devices_lan", "lan_fingerprint"),
        Index("ix_devices_h100eq", "h100_equivalent"),
    )


class DeviceTelemetry(Base):
    __tablename__ = "device_telemetry"

    id: Mapped[str] = mapped_column(String(40), primary_key=True, default=new_ulid)
    device_id: Mapped[str] = mapped_column(
        ForeignKey("devices.id", ondelete="CASCADE"), nullable=False
    )
    sampled_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)

    cpu_usage_pct: Mapped[float] = mapped_column(Float, default=0.0, nullable=False)
    gpu_usage_pct: Mapped[float] = mapped_column(Float, default=0.0, nullable=False)
    ram_usage_pct: Mapped[float] = mapped_column(Float, default=0.0, nullable=False)
    temperature_c: Mapped[float | None] = mapped_column(Float)
    power_watts: Mapped[float | None] = mapped_column(Float)

    rssi_dbm: Mapped[float | None] = mapped_column(Float)
    download_mbps: Mapped[float | None] = mapped_column(Float)
    upload_mbps: Mapped[float | None] = mapped_column(Float)

    extras: Mapped[dict] = mapped_column(JSONB, default=dict, nullable=False)

    device: Mapped["Device"] = relationship(back_populates="telemetry")

    __table_args__ = (Index("ix_telemetry_device_time", "device_id", "sampled_at"),)
