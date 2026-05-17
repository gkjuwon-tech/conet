from __future__ import annotations

import enum
from datetime import datetime
from typing import TYPE_CHECKING

from sqlalchemy import (
    Boolean,
    DateTime,
    Enum,
    ForeignKey,
    Index,
    Integer,
    String,
    UniqueConstraint,
)
from sqlalchemy.dialects.postgresql import INET, JSONB
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db.base import Base
from app.utils.ids import new_ulid

if TYPE_CHECKING:
    from app.db.models.user import User


class LanClaimStatus(str, enum.Enum):
    pending_otp = "pending_otp"
    verified = "verified"
    expired = "expired"
    revoked = "revoked"
    disputed = "disputed"


class LanClaim(Base):
    """A user's verified ownership of a specific LAN (lan_fingerprint).

    Required before that user can register any device whose lan_fingerprint
    matches. Verification is via an OTP delivered to the user's registered
    email plus a same-LAN proof (the request must originate from a host whose
    LAN-fingerprint matches the claim).
    """

    __tablename__ = "lan_claims"

    id: Mapped[str] = mapped_column(String(40), primary_key=True, default=new_ulid)
    user_id: Mapped[str] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), nullable=False
    )
    lan_fingerprint: Mapped[str] = mapped_column(String(64), nullable=False)

    status: Mapped[LanClaimStatus] = mapped_column(
        Enum(
            LanClaimStatus,
            name="lan_claim_status",
            values_callable=lambda obj: [e.value for e in obj],
        ),
        nullable=False,
        default=LanClaimStatus.pending_otp,
    )

    otp_hash: Mapped[str | None] = mapped_column(String(128))
    otp_expires_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    otp_attempts: Mapped[int] = mapped_column(Integer, default=0, nullable=False)

    verified_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    revoked_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    grace_until: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))

    requested_ip: Mapped[str | None] = mapped_column(INET)
    requested_user_agent: Mapped[str | None] = mapped_column(String(255))
    gateway_ip: Mapped[str | None] = mapped_column(INET)
    gateway_mac: Mapped[str | None] = mapped_column(String(40))
    advertised_subnet: Mapped[str | None] = mapped_column(String(40))
    label: Mapped[str | None] = mapped_column(String(120))

    is_active: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)
    metadata_: Mapped[dict] = mapped_column("metadata", JSONB, default=dict, nullable=False)

    user: Mapped["User"] = relationship()

    __table_args__ = (
        UniqueConstraint(
            "user_id", "lan_fingerprint", name="uq_lan_claim_user_fp"
        ),
        Index("ix_lan_claims_fp_status", "lan_fingerprint", "status"),
        Index("ix_lan_claims_user", "user_id", "status"),
    )
