from __future__ import annotations

import enum
from datetime import datetime
from typing import TYPE_CHECKING

from sqlalchemy import (
    BigInteger,
    Boolean,
    DateTime,
    Enum,
    ForeignKey,
    Index,
    String,
)
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db.base import Base
from app.utils.ids import new_ulid, payout_handle

if TYPE_CHECKING:
    from app.db.models.user import User


class PayoutStatus(str, enum.Enum):
    pending = "pending"
    processing = "processing"
    paid = "paid"
    failed = "failed"
    cancelled = "cancelled"
    held = "held"


class Payout(Base):
    __tablename__ = "payouts"

    id: Mapped[str] = mapped_column(String(40), primary_key=True, default=new_ulid)
    handle: Mapped[str] = mapped_column(
        String(64), nullable=False, unique=True, default=payout_handle
    )

    user_id: Mapped[str] = mapped_column(
        ForeignKey("users.id", ondelete="RESTRICT"), nullable=False
    )

    amount_cents: Mapped[int] = mapped_column(BigInteger, nullable=False)
    currency: Mapped[str] = mapped_column(String(3), default="USD", nullable=False)
    status: Mapped[PayoutStatus] = mapped_column(
        Enum(PayoutStatus, name="payout_status"),
        default=PayoutStatus.pending,
        nullable=False,
    )

    period_start: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    period_end: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)

    method: Mapped[str] = mapped_column(String(40), default="stripe", nullable=False)
    external_id: Mapped[str | None] = mapped_column(String(128))
    failure_reason: Mapped[str | None] = mapped_column(String(512))

    initiated_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    settled_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))

    metadata_: Mapped[dict] = mapped_column("metadata", JSONB, default=dict, nullable=False)

    user: Mapped["User"] = relationship(back_populates="payouts")

    __table_args__ = (
        Index("ix_payouts_user_status", "user_id", "status"),
        Index("ix_payouts_period", "period_start", "period_end"),
    )


class PayoutLedgerEntry(Base):
    __tablename__ = "payout_ledger_entries"

    id: Mapped[str] = mapped_column(String(40), primary_key=True, default=new_ulid)
    payout_id: Mapped[str | None] = mapped_column(
        ForeignKey("payouts.id", ondelete="SET NULL")
    )
    user_id: Mapped[str] = mapped_column(
        ForeignKey("users.id", ondelete="RESTRICT"), nullable=False
    )
    device_id: Mapped[str | None] = mapped_column(
        ForeignKey("devices.id", ondelete="SET NULL")
    )
    workunit_id: Mapped[str | None] = mapped_column(
        ForeignKey("workunits.id", ondelete="SET NULL")
    )
    job_id: Mapped[str | None] = mapped_column(
        ForeignKey("jobs.id", ondelete="SET NULL")
    )

    amount_cents: Mapped[int] = mapped_column(BigInteger, nullable=False)
    weight: Mapped[float] = mapped_column(BigInteger, nullable=False, default=0)

    occurred_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    is_finalized: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    note: Mapped[str | None] = mapped_column(String(512))

    metadata_: Mapped[dict] = mapped_column("metadata", JSONB, default=dict, nullable=False)

    __table_args__ = (
        Index("ix_ledger_user_time", "user_id", "occurred_at"),
        Index("ix_ledger_payout", "payout_id"),
        Index("ix_ledger_device", "device_id"),
    )
