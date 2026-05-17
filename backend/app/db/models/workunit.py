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
from app.utils.ids import new_ulid, workunit_handle

if TYPE_CHECKING:
    from app.db.models.device import Device
    from app.db.models.job import Job


class WorkUnitStatus(str, enum.Enum):
    pending = "pending"
    dispatched = "dispatched"
    in_flight = "in_flight"
    succeeded = "succeeded"
    failed = "failed"
    timed_out = "timed_out"
    cancelled = "cancelled"
    consensus_pending = "consensus_pending"
    consensus_failed = "consensus_failed"


class WorkUnit(Base):
    __tablename__ = "workunits"

    id: Mapped[str] = mapped_column(String(40), primary_key=True, default=new_ulid)
    handle: Mapped[str] = mapped_column(
        String(64), nullable=False, unique=True, default=workunit_handle
    )

    job_id: Mapped[str] = mapped_column(
        ForeignKey("jobs.id", ondelete="CASCADE"), nullable=False
    )
    sequence_no: Mapped[int] = mapped_column(BigInteger, nullable=False)

    status: Mapped[WorkUnitStatus] = mapped_column(
        Enum(WorkUnitStatus, name="workunit_status"),
        default=WorkUnitStatus.pending,
        nullable=False,
    )

    payload: Mapped[dict] = mapped_column(JSONB, default=dict, nullable=False)
    payload_hash: Mapped[str] = mapped_column(String(64), nullable=False)
    expected_runtime_seconds: Mapped[int] = mapped_column(Integer, default=60, nullable=False)
    weight: Mapped[float] = mapped_column(Float, default=1.0, nullable=False)

    redundancy_required: Mapped[int] = mapped_column(Integer, default=2, nullable=False)
    redundancy_satisfied: Mapped[int] = mapped_column(Integer, default=0, nullable=False)

    final_result: Mapped[dict | None] = mapped_column(JSONB)
    final_result_hash: Mapped[str | None] = mapped_column(String(64))
    consensus_score: Mapped[float | None] = mapped_column(Float)

    dispatched_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    completed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    deadline_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))

    metadata_: Mapped[dict] = mapped_column("metadata", JSONB, default=dict, nullable=False)

    job: Mapped["Job"] = relationship(back_populates="workunits")
    attempts: Mapped[list["WorkUnitAttempt"]] = relationship(
        back_populates="workunit", cascade="all, delete-orphan"
    )

    __table_args__ = (
        Index("ix_workunits_job_status", "job_id", "status"),
        Index("ix_workunits_status_deadline", "status", "deadline_at"),
    )


class WorkUnitAttempt(Base):
    __tablename__ = "workunit_attempts"

    id: Mapped[str] = mapped_column(String(40), primary_key=True, default=new_ulid)

    workunit_id: Mapped[str] = mapped_column(
        ForeignKey("workunits.id", ondelete="CASCADE"), nullable=False
    )
    device_id: Mapped[str] = mapped_column(
        ForeignKey("devices.id", ondelete="RESTRICT"), nullable=False
    )

    attempt_no: Mapped[int] = mapped_column(Integer, default=1, nullable=False)
    status: Mapped[WorkUnitStatus] = mapped_column(
        Enum(WorkUnitStatus, name="workunit_status", create_type=False),
        default=WorkUnitStatus.dispatched,
        nullable=False,
    )

    started_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    completed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    runtime_ms: Mapped[int | None] = mapped_column(BigInteger)

    result: Mapped[dict | None] = mapped_column(JSONB)
    result_hash: Mapped[str | None] = mapped_column(String(64))
    proof: Mapped[str | None] = mapped_column(String(2048))
    error_code: Mapped[str | None] = mapped_column(String(64))
    error_message: Mapped[str | None] = mapped_column(String(1024))

    accepted: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    rewarded_cents: Mapped[int] = mapped_column(BigInteger, default=0, nullable=False)

    metadata_: Mapped[dict] = mapped_column("metadata", JSONB, default=dict, nullable=False)

    workunit: Mapped["WorkUnit"] = relationship(back_populates="attempts")
    device: Mapped["Device"] = relationship(back_populates="attempts")

    __table_args__ = (
        Index("ix_attempts_device_status", "device_id", "status"),
        Index("ix_attempts_workunit", "workunit_id"),
    )
