"""Stripe-backed enterprise billing models.

Two ledgers live here:

* ``EnterpriseInvoice`` — money flowing IN (top-ups, refunds), authoritative
  source for the ``Enterprise.credit_balance_cents`` running balance.
* ``EnterpriseChargeEvent`` — money flowing OUT (job spend), debiting the
  same balance. Never positive.
"""
from __future__ import annotations

import enum
from datetime import datetime

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
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base
from app.utils.ids import new_ulid


class InvoiceKind(str, enum.Enum):
    topup = "topup"
    refund = "refund"
    promotional_credit = "promotional_credit"
    chargeback = "chargeback"


class InvoiceStatus(str, enum.Enum):
    pending = "pending"
    succeeded = "succeeded"
    failed = "failed"
    refunded = "refunded"
    cancelled = "cancelled"


class EnterpriseInvoice(Base):
    __tablename__ = "enterprise_invoices"

    id: Mapped[str] = mapped_column(String(40), primary_key=True, default=new_ulid)
    enterprise_id: Mapped[str] = mapped_column(
        ForeignKey("enterprises.id", ondelete="CASCADE"), nullable=False
    )

    kind: Mapped[InvoiceKind] = mapped_column(
        Enum(InvoiceKind, name="invoice_kind"),
        nullable=False,
        default=InvoiceKind.topup,
    )
    status: Mapped[InvoiceStatus] = mapped_column(
        Enum(InvoiceStatus, name="invoice_status"),
        nullable=False,
        default=InvoiceStatus.pending,
    )

    amount_cents: Mapped[int] = mapped_column(BigInteger, nullable=False)
    currency: Mapped[str] = mapped_column(String(3), nullable=False, default="USD")
    description: Mapped[str | None] = mapped_column(String(255))

    stripe_payment_intent_id: Mapped[str | None] = mapped_column(String(80))
    stripe_charge_id: Mapped[str | None] = mapped_column(String(80))
    stripe_customer_id: Mapped[str | None] = mapped_column(String(80))
    stripe_client_secret: Mapped[str | None] = mapped_column(String(255))
    stripe_status: Mapped[str | None] = mapped_column(String(40))

    initiated_by_user_id: Mapped[str | None] = mapped_column(String(40))

    paid_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    failed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    failure_reason: Mapped[str | None] = mapped_column(String(512))

    metadata_: Mapped[dict] = mapped_column(
        "metadata", JSONB, default=dict, nullable=False
    )

    __table_args__ = (
        Index("ix_invoices_enterprise_status", "enterprise_id", "status"),
        Index("ix_invoices_pi", "stripe_payment_intent_id"),
    )


class ChargeReason(str, enum.Enum):
    job_authorization_hold = "job_authorization_hold"
    job_authorization_release = "job_authorization_release"
    job_settlement = "job_settlement"
    shell_session_metered = "shell_session_metered"
    adjustment = "adjustment"


class EnterpriseChargeEvent(Base):
    __tablename__ = "enterprise_charges"

    id: Mapped[str] = mapped_column(String(40), primary_key=True, default=new_ulid)
    enterprise_id: Mapped[str] = mapped_column(
        ForeignKey("enterprises.id", ondelete="CASCADE"), nullable=False
    )

    reason: Mapped[ChargeReason] = mapped_column(
        Enum(ChargeReason, name="charge_reason"),
        nullable=False,
    )

    # Negative for debits, positive for releases / refunds.
    amount_cents: Mapped[int] = mapped_column(BigInteger, nullable=False)

    job_id: Mapped[str | None] = mapped_column(
        ForeignKey("jobs.id", ondelete="SET NULL")
    )
    shell_session_id: Mapped[str | None] = mapped_column(String(40))

    occurred_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False
    )
    description: Mapped[str | None] = mapped_column(String(255))
    is_finalized: Mapped[bool] = mapped_column(
        Boolean, default=True, nullable=False
    )
    metadata_: Mapped[dict] = mapped_column(
        "metadata", JSONB, default=dict, nullable=False
    )

    __table_args__ = (
        Index("ix_charges_enterprise_time", "enterprise_id", "occurred_at"),
        Index("ix_charges_job", "job_id"),
        Index("ix_charges_reason", "reason"),
    )
