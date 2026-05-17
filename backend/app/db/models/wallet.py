from __future__ import annotations

import enum
from datetime import datetime
from typing import TYPE_CHECKING

from sqlalchemy import (
    BigInteger,
    DateTime,
    Enum,
    ForeignKey,
    Index,
    String,
)
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db.base import Base
from app.utils.ids import new_ulid

if TYPE_CHECKING:
    from app.db.models.user import User


class WalletEntryKind(str, enum.Enum):
    earning = "earning"
    bonus = "bonus"
    referral = "referral"
    adjustment = "adjustment"
    payout = "payout"
    fee = "fee"
    chargeback = "chargeback"


class Wallet(Base):
    __tablename__ = "wallets"

    id: Mapped[str] = mapped_column(String(40), primary_key=True, default=new_ulid)
    user_id: Mapped[str] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), nullable=False, unique=True
    )

    available_cents: Mapped[int] = mapped_column(BigInteger, default=0, nullable=False)
    pending_cents: Mapped[int] = mapped_column(BigInteger, default=0, nullable=False)
    held_cents: Mapped[int] = mapped_column(BigInteger, default=0, nullable=False)
    lifetime_earned_cents: Mapped[int] = mapped_column(BigInteger, default=0, nullable=False)
    lifetime_paid_cents: Mapped[int] = mapped_column(BigInteger, default=0, nullable=False)

    last_activity_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))

    metadata_: Mapped[dict] = mapped_column("metadata", JSONB, default=dict, nullable=False)

    user: Mapped["User"] = relationship(back_populates="wallet")
    entries: Mapped[list["WalletEntry"]] = relationship(
        back_populates="wallet", cascade="all, delete-orphan"
    )


class WalletEntry(Base):
    __tablename__ = "wallet_entries"

    id: Mapped[str] = mapped_column(String(40), primary_key=True, default=new_ulid)
    wallet_id: Mapped[str] = mapped_column(
        ForeignKey("wallets.id", ondelete="CASCADE"), nullable=False
    )

    kind: Mapped[WalletEntryKind] = mapped_column(
        Enum(WalletEntryKind, name="wallet_entry_kind"), nullable=False
    )
    amount_cents: Mapped[int] = mapped_column(BigInteger, nullable=False)
    balance_after_cents: Mapped[int] = mapped_column(BigInteger, nullable=False)
    occurred_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)

    reference_type: Mapped[str | None] = mapped_column(String(40))
    reference_id: Mapped[str | None] = mapped_column(String(64))
    description: Mapped[str | None] = mapped_column(String(512))

    metadata_: Mapped[dict] = mapped_column("metadata", JSONB, default=dict, nullable=False)

    wallet: Mapped["Wallet"] = relationship(back_populates="entries")

    __table_args__ = (
        Index("ix_wallet_entries_wallet_time", "wallet_id", "occurred_at"),
        Index("ix_wallet_entries_kind", "kind"),
    )
