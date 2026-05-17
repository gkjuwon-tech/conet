"""Interactive shell sessions — RunPod-style PTY rentals.

When an enterprise creates a ``compute.shell`` job, we provision a
ShellSession that lives on a single device. Two WebSockets are bound to it:

* the **device** side (one of the consumer agents the enterprise leased) —
  it spawns ``node-pty`` against a sandbox and pipes stdin/stdout back,
* the **enterprise** side (xterm.js in the desktop app) — typing flows the
  other way.

The backend is a small dumb proxy in the middle, plus an authorisation +
metering layer. Per-second charges debit the enterprise as long as both
sockets are connected.
"""
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
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base
from app.utils.ids import new_ulid

if TYPE_CHECKING:
    from app.db.models.device import Device


class ShellSessionStatus(str, enum.Enum):
    pending = "pending"
    waiting_device = "waiting_device"
    active = "active"
    expired = "expired"
    closed = "closed"
    revoked = "revoked"


class ShellSession(Base):
    __tablename__ = "shell_sessions"

    id: Mapped[str] = mapped_column(String(40), primary_key=True, default=new_ulid)

    enterprise_id: Mapped[str] = mapped_column(
        ForeignKey("enterprises.id", ondelete="CASCADE"), nullable=False
    )
    job_id: Mapped[str] = mapped_column(
        ForeignKey("jobs.id", ondelete="CASCADE"), nullable=False
    )
    device_id: Mapped[str] = mapped_column(
        ForeignKey("devices.id", ondelete="RESTRICT"), nullable=False
    )

    status: Mapped[ShellSessionStatus] = mapped_column(
        Enum(ShellSessionStatus, name="shell_session_status"),
        default=ShellSessionStatus.pending,
        nullable=False,
    )

    enterprise_token: Mapped[str] = mapped_column(String(80), nullable=False, unique=True)
    device_token: Mapped[str] = mapped_column(String(80), nullable=False, unique=True)

    # Connection knobs
    image: Mapped[str | None] = mapped_column(String(160))
    workdir: Mapped[str | None] = mapped_column(String(256))
    env: Mapped[dict] = mapped_column(JSONB, default=dict, nullable=False)
    cmd: Mapped[str | None] = mapped_column(String(512))

    # Resource limits the device honours.
    cpu_cap_pct: Mapped[float] = mapped_column(Float, default=80.0, nullable=False)
    memory_mb_cap: Mapped[int] = mapped_column(Integer, default=2048, nullable=False)
    disk_mb_cap: Mapped[int] = mapped_column(Integer, default=4096, nullable=False)
    network_egress_mbps_cap: Mapped[float] = mapped_column(Float, default=10.0, nullable=False)

    # Lifecycle
    created_at_ts: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    activated_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    last_io_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    closed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)

    # Metering
    rate_usd_per_hour: Mapped[float] = mapped_column(Float, nullable=False, default=0.0)
    runtime_seconds: Mapped[int] = mapped_column(BigInteger, default=0, nullable=False)
    metered_cents: Mapped[int] = mapped_column(BigInteger, default=0, nullable=False)
    bytes_in: Mapped[int] = mapped_column(BigInteger, default=0, nullable=False)
    bytes_out: Mapped[int] = mapped_column(BigInteger, default=0, nullable=False)

    revoked_reason: Mapped[str | None] = mapped_column(String(255))

    metadata_: Mapped[dict] = mapped_column(
        "metadata", JSONB, default=dict, nullable=False
    )

    __table_args__ = (
        Index("ix_shell_enterprise_status", "enterprise_id", "status"),
        Index("ix_shell_device", "device_id", "status"),
        Index("ix_shell_expires", "expires_at"),
    )
