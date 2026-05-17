from __future__ import annotations

import enum
from datetime import datetime
from typing import TYPE_CHECKING

from sqlalchemy import Boolean, DateTime, Enum, Index, String
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db.base import Base
from app.utils.ids import new_ulid

if TYPE_CHECKING:
    from app.db.models.device import Device
    from app.db.models.payout import Payout
    from app.db.models.wallet import Wallet


class UserStatus(str, enum.Enum):
    pending = "pending"
    active = "active"
    suspended = "suspended"
    banned = "banned"
    closed = "closed"


class User(Base):
    __tablename__ = "users"

    id: Mapped[str] = mapped_column(String(40), primary_key=True, default=new_ulid)
    email: Mapped[str] = mapped_column(String(255), nullable=False, unique=True)
    display_name: Mapped[str | None] = mapped_column(String(120))
    password_hash: Mapped[str] = mapped_column(String(255), nullable=False)

    status: Mapped[UserStatus] = mapped_column(
        Enum(UserStatus, name="user_status"),
        default=UserStatus.pending,
        nullable=False,
    )

    country_code: Mapped[str | None] = mapped_column(String(2))
    timezone: Mapped[str | None] = mapped_column(String(64))
    locale: Mapped[str] = mapped_column(String(16), default="en-US", nullable=False)

    payout_method: Mapped[str | None] = mapped_column(String(40))
    stripe_account_id: Mapped[str | None] = mapped_column(String(64))

    accepted_tos_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    accepted_tos_version: Mapped[str | None] = mapped_column(String(16))

    email_verified: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    two_factor_enabled: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    two_factor_secret: Mapped[str | None] = mapped_column(String(64))

    referral_code: Mapped[str | None] = mapped_column(String(16), unique=True)
    referred_by: Mapped[str | None] = mapped_column(String(40))

    settings: Mapped[dict] = mapped_column(JSONB, default=dict, nullable=False)
    metadata_: Mapped[dict] = mapped_column("metadata", JSONB, default=dict, nullable=False)

    devices: Mapped[list["Device"]] = relationship(
        back_populates="owner", cascade="all, delete-orphan"
    )
    wallet: Mapped["Wallet"] = relationship(
        back_populates="user", uselist=False, cascade="all, delete-orphan"
    )
    payouts: Mapped[list["Payout"]] = relationship(back_populates="user")

    __table_args__ = (
        Index("ix_users_status", "status"),
        Index("ix_users_country", "country_code"),
    )
