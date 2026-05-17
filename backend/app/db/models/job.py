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
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db.base import Base
from app.utils.ids import job_handle, new_ulid

if TYPE_CHECKING:
    from app.db.models.cluster import Cluster
    from app.db.models.workunit import WorkUnit


class JobKind(str, enum.Enum):
    hashcrack_range = "hashcrack.range"
    hashcrack_dict = "hashcrack.dict"
    fhe_share = "fhe.share"
    mpc_share = "mpc.share"
    ml_embed_public = "ml.embed.public"
    render_tile = "render.tile"
    compute_shell = "compute.shell"


class JobStatus(str, enum.Enum):
    draft = "draft"
    queued = "queued"
    leasing = "leasing"
    running = "running"
    succeeded = "succeeded"
    failed = "failed"
    cancelled = "cancelled"
    timed_out = "timed_out"
    rejected = "rejected"


class Job(Base):
    __tablename__ = "jobs"

    id: Mapped[str] = mapped_column(String(40), primary_key=True, default=new_ulid)
    handle: Mapped[str] = mapped_column(String(64), nullable=False, unique=True, default=job_handle)

    enterprise_id: Mapped[str] = mapped_column(
        ForeignKey("enterprises.id", ondelete="RESTRICT"), nullable=False
    )

    kind: Mapped[JobKind] = mapped_column(
        Enum(
            JobKind,
            name="job_kind",
            values_callable=lambda obj: [e.value for e in obj],
        ),
        nullable=False,
    )
    status: Mapped[JobStatus] = mapped_column(
        Enum(JobStatus, name="job_status"),
        default=JobStatus.draft,
        nullable=False,
    )

    title: Mapped[str | None] = mapped_column(String(160))
    description: Mapped[str | None] = mapped_column(String(2000))

    input_manifest: Mapped[dict] = mapped_column(JSONB, default=dict, nullable=False)
    output_manifest: Mapped[dict] = mapped_column(JSONB, default=dict, nullable=False)
    isolation_policy: Mapped[dict] = mapped_column(JSONB, default=dict, nullable=False)

    target_cluster_count: Mapped[int] = mapped_column(Integer, default=1, nullable=False)
    target_h100_equivalent: Mapped[float] = mapped_column(Float, default=0.0, nullable=False)
    max_budget_cents: Mapped[int] = mapped_column(BigInteger, default=0, nullable=False)
    max_runtime_seconds: Mapped[int] = mapped_column(Integer, default=3600, nullable=False)
    redundancy: Mapped[int] = mapped_column(Integer, default=2, nullable=False)
    consensus_threshold: Mapped[float] = mapped_column(Float, default=0.66, nullable=False)

    workunit_total: Mapped[int] = mapped_column(BigInteger, default=0, nullable=False)
    workunit_completed: Mapped[int] = mapped_column(BigInteger, default=0, nullable=False)
    workunit_failed: Mapped[int] = mapped_column(BigInteger, default=0, nullable=False)

    spent_cents: Mapped[int] = mapped_column(BigInteger, default=0, nullable=False)
    paid_to_users_cents: Mapped[int] = mapped_column(BigInteger, default=0, nullable=False)
    platform_fee_cents: Mapped[int] = mapped_column(BigInteger, default=0, nullable=False)

    submitted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    started_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    finished_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    deadline_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))

    callback_url: Mapped[str | None] = mapped_column(String(2048))
    callback_secret: Mapped[str | None] = mapped_column(String(255))
    callback_delivered: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)

    metadata_: Mapped[dict] = mapped_column("metadata", JSONB, default=dict, nullable=False)

    leases: Mapped[list["ClusterLease"]] = relationship(back_populates="job", cascade="all, delete-orphan")
    workunits: Mapped[list["WorkUnit"]] = relationship(back_populates="job")

    __table_args__ = (
        Index("ix_jobs_enterprise_status", "enterprise_id", "status"),
        Index("ix_jobs_kind_status", "kind", "status"),
    )


class ClusterLease(Base):
    __tablename__ = "cluster_leases"

    id: Mapped[str] = mapped_column(String(40), primary_key=True, default=new_ulid)

    cluster_id: Mapped[str] = mapped_column(
        ForeignKey("clusters.id", ondelete="RESTRICT"), nullable=False
    )
    job_id: Mapped[str] = mapped_column(
        ForeignKey("jobs.id", ondelete="CASCADE"), nullable=False
    )

    started_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    ended_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    expected_end_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))

    rate_usd_per_hour: Mapped[float] = mapped_column(Float, nullable=False)
    runtime_seconds: Mapped[int] = mapped_column(BigInteger, default=0, nullable=False)
    billed_cents: Mapped[int] = mapped_column(BigInteger, default=0, nullable=False)

    is_open: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)
    metadata_: Mapped[dict] = mapped_column("metadata", JSONB, default=dict, nullable=False)

    cluster: Mapped["Cluster"] = relationship(back_populates="leases")
    job: Mapped["Job"] = relationship(back_populates="leases")

    __table_args__ = (
        Index("ix_leases_open", "is_open"),
        Index("ix_leases_job", "job_id"),
        Index("ix_leases_cluster_open", "cluster_id", "is_open"),
    )
