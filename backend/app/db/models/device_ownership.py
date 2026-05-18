"""Persistent device-ownership challenge state.

Replaces the in-memory ``OwnershipVerificationService`` that lost state on
every restart and could not be shared across uvicorn workers. Each
challenge is a row backed by Postgres so the verification window survives
restarts, scales horizontally, and produces a real audit trail.

The high-level flow is:

1. The Electron consumer hits ``POST /v1/devices/ownership/challenge`` to
   prove ownership of a freshly-scanned LAN device. We mint a row with a
   freshly-generated nonce and (for the PIN method) a hashed PIN. The PIN
   is delivered to the consumer side-channel, which is supposed to push it
   onto the target device via the vendor channel that will *also* be used
   to install the agent — pushing the PIN therefore implicitly proves
   write access to the device.

2. The user reads the PIN off the device's own display (or types the MAC
   they see in the device's settings UI) and hits
   ``POST /v1/devices/ownership/respond``. We compare the response in
   constant time, atomically bump ``attempts``, and either flip the row
   to ``verified`` (single use) or to ``locked`` once ``max_attempts`` is
   hit.

3. The claim service calls ``consume`` exactly once — that moves the row
   from ``verified`` to ``consumed``, preventing replay of a single
   verification against multiple pair attempts.
"""

from __future__ import annotations

from datetime import datetime
from enum import Enum, StrEnum
from typing import TYPE_CHECKING

from sqlalchemy import (
    DateTime,
    Enum,
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
    from app.db.models.user import User


class OwnershipChallengeMethod(StrEnum):
    """How we expect the user to prove ownership.

    * ``pin_display`` — server mints a PIN; the controller pushes it to
      the device's screen via the vendor channel it would use to install
      the agent. The user reads the digits back. The fact that the push
      worked is itself proof of control over the device.

    * ``mac_serial`` — for headless devices. The user looks up the MAC
      (and optional serial) inside the device's own admin UI / router
      page and types it back. We compare against what the scanner just
      saw on the wire — if the user can read the MAC out of the device,
      they have at least admin access on the same LAN.

    * ``signed_attestation`` — for devices that already shipped with an
      ElectroMesh public key. The device signs the server nonce; we
      verify with :func:`app.crypto.attestation.verify_signed_attestation`.
    """

    pin_display = "pin_display"
    mac_serial = "mac_serial"
    signed_attestation = "signed_attestation"


class OwnershipChallengeStatus(StrEnum):
    pending = "pending"
    verified = "verified"
    consumed = "consumed"
    expired = "expired"
    locked = "locked"
    cancelled = "cancelled"


class DeviceOwnershipChallenge(Base):
    """One ownership challenge against one (user, LAN device) pair."""

    __tablename__ = "device_ownership_challenges"

    id: Mapped[str] = mapped_column(String(40), primary_key=True, default=new_ulid)
    user_id: Mapped[str] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), nullable=False
    )

    device_ip: Mapped[str] = mapped_column(INET, nullable=False)
    device_mac: Mapped[str | None] = mapped_column(String(40))
    expected_mac: Mapped[str | None] = mapped_column(String(40))
    expected_serial: Mapped[str | None] = mapped_column(String(128))

    method: Mapped[OwnershipChallengeMethod] = mapped_column(
        Enum(  # type: ignore[arg-type]
            OwnershipChallengeMethod,
            name="device_ownership_method",
            values_callable=lambda obj: [e.value for e in obj],
        ),
        nullable=False,
    )
    status: Mapped[OwnershipChallengeStatus] = mapped_column(
        Enum(  # type: ignore[arg-type]
            OwnershipChallengeStatus,
            name="device_ownership_status",
            values_callable=lambda obj: [e.value for e in obj],
        ),
        nullable=False,
        default=OwnershipChallengeStatus.pending,
    )

    # Cryptographic material. Plaintext PINs are NEVER stored.
    nonce: Mapped[str] = mapped_column(String(64), nullable=False)
    pin_hash: Mapped[str | None] = mapped_column(String(128))
    pin_salt: Mapped[str | None] = mapped_column(String(64))

    # Optional public key for ``signed_attestation`` flow.
    public_key_pem: Mapped[str | None] = mapped_column(String(2048))

    # Window
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    verified_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    consumed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))

    # Rate limiting
    attempts: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    max_attempts: Mapped[int] = mapped_column(Integer, default=5, nullable=False)

    # Audit metadata
    requester_ip: Mapped[str | None] = mapped_column(INET)
    requester_user_agent: Mapped[str | None] = mapped_column(String(255))
    delivery: Mapped[dict] = mapped_column(JSONB, default=dict, nullable=False)
    metadata_: Mapped[dict] = mapped_column("metadata", JSONB, default=dict, nullable=False)

    user: Mapped[User] = relationship()

    __table_args__ = (
        Index(
            "ix_device_ownership_user_ip_status",
            "user_id", "device_ip", "status",
        ),
        Index(
            "ix_device_ownership_expires",
            "expires_at",
        ),
    )

    @property
    def is_terminal(self) -> bool:
        return self.status in {
            OwnershipChallengeStatus.consumed,
            OwnershipChallengeStatus.expired,
            OwnershipChallengeStatus.locked,
            OwnershipChallengeStatus.cancelled,
        }


class DeviceOwnershipAuditEvent(StrEnum):
    challenge_created = "challenge_created"
    response_accepted = "response_accepted"
    response_rejected = "response_rejected"
    challenge_expired = "challenge_expired"
    challenge_locked = "challenge_locked"
    challenge_cancelled = "challenge_cancelled"
    verification_consumed = "verification_consumed"


class DeviceOwnershipAudit(Base):
    """Append-only audit log for device ownership decisions.

    Every challenge transition writes one row so we can investigate
    incidents long after the underlying challenge row has been deleted.
    """

    __tablename__ = "device_ownership_audit"

    id: Mapped[str] = mapped_column(String(40), primary_key=True, default=new_ulid)
    challenge_id: Mapped[str | None] = mapped_column(
        ForeignKey("device_ownership_challenges.id", ondelete="SET NULL"),
        nullable=True,
    )
    user_id: Mapped[str | None] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )
    device_ip: Mapped[str | None] = mapped_column(INET)
    event: Mapped[DeviceOwnershipAuditEvent] = mapped_column(
        Enum(  # type: ignore[arg-type]
            DeviceOwnershipAuditEvent,
            name="device_ownership_audit_event",
            values_callable=lambda obj: [e.value for e in obj],
        ),
        nullable=False,
    )
    detail: Mapped[dict] = mapped_column(JSONB, default=dict, nullable=False)

    __table_args__ = (
        Index("ix_device_ownership_audit_user_time", "user_id", "created_at"),
        Index("ix_device_ownership_audit_ip_time", "device_ip", "created_at"),
    )
