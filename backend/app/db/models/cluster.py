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
    UniqueConstraint,
)
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db.base import Base
from app.utils.ids import cluster_handle, new_ulid

if TYPE_CHECKING:
    from app.db.models.device import Device
    from app.db.models.job import ClusterLease


class ClusterStatus(str, enum.Enum):
    forming = "forming"
    available = "available"
    leased = "leased"
    draining = "draining"
    retired = "retired"


class Cluster(Base):
    __tablename__ = "clusters"

    id: Mapped[str] = mapped_column(String(40), primary_key=True, default=new_ulid)
    handle: Mapped[str] = mapped_column(String(64), nullable=False, unique=True, default=cluster_handle)

    sequence_no: Mapped[int] = mapped_column(BigInteger, nullable=False, unique=True)
    status: Mapped[ClusterStatus] = mapped_column(
        Enum(ClusterStatus, name="cluster_status"),
        default=ClusterStatus.forming,
        nullable=False,
    )

    member_count: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    target_size: Mapped[int] = mapped_column(Integer, nullable=False)

    aggregate_cpu_gflops: Mapped[float] = mapped_column(Float, default=0.0, nullable=False)
    aggregate_gpu_gflops: Mapped[float] = mapped_column(Float, default=0.0, nullable=False)
    aggregate_ram_mb: Mapped[int] = mapped_column(BigInteger, default=0, nullable=False)
    aggregate_vram_mb: Mapped[int] = mapped_column(BigInteger, default=0, nullable=False)
    aggregate_storage_gb: Mapped[int] = mapped_column(BigInteger, default=0, nullable=False)
    aggregate_hash_mhs_sha256: Mapped[float] = mapped_column(Float, default=0.0, nullable=False)
    aggregate_network_mbps: Mapped[float] = mapped_column(Float, default=0.0, nullable=False)

    h100_equivalent: Mapped[float] = mapped_column(Float, default=0.0, nullable=False)
    reliability_score: Mapped[float] = mapped_column(Float, default=0.0, nullable=False)
    trust_score: Mapped[float] = mapped_column(Float, default=0.0, nullable=False)
    diversity_index: Mapped[float] = mapped_column(Float, default=0.0, nullable=False)

    price_usd_per_hour: Mapped[float] = mapped_column(Float, nullable=False, default=0.0)
    price_breakdown: Mapped[dict] = mapped_column(JSONB, default=dict, nullable=False)
    capability_summary: Mapped[dict] = mapped_column(JSONB, default=dict, nullable=False)
    composition: Mapped[dict] = mapped_column(JSONB, default=dict, nullable=False)

    formed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    available_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    leased_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    retired_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))

    is_listed: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)
    region_hint: Mapped[str | None] = mapped_column(String(32))

    metadata_: Mapped[dict] = mapped_column("metadata", JSONB, default=dict, nullable=False)

    memberships: Mapped[list["ClusterMembership"]] = relationship(
        back_populates="cluster", cascade="all, delete-orphan"
    )
    leases: Mapped[list["ClusterLease"]] = relationship(back_populates="cluster")

    __table_args__ = (
        Index("ix_clusters_status_listed", "status", "is_listed"),
        Index("ix_clusters_h100eq", "h100_equivalent"),
        Index("ix_clusters_seq", "sequence_no"),
    )


class ClusterMembership(Base):
    __tablename__ = "cluster_memberships"

    id: Mapped[str] = mapped_column(String(40), primary_key=True, default=new_ulid)
    cluster_id: Mapped[str] = mapped_column(
        ForeignKey("clusters.id", ondelete="CASCADE"), nullable=False
    )
    device_id: Mapped[str] = mapped_column(
        ForeignKey("devices.id", ondelete="RESTRICT"), nullable=False
    )

    weight: Mapped[float] = mapped_column(Float, nullable=False, default=1.0)
    joined_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    left_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    is_active: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)

    role: Mapped[str] = mapped_column(String(24), default="worker", nullable=False)
    snapshot: Mapped[dict] = mapped_column(JSONB, default=dict, nullable=False)

    cluster: Mapped["Cluster"] = relationship(back_populates="memberships")
    device: Mapped["Device"] = relationship(back_populates="memberships")

    __table_args__ = (
        UniqueConstraint("cluster_id", "device_id", name="uq_membership_pair"),
        Index("ix_memberships_active", "cluster_id", "is_active"),
    )
