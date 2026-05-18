"""Device-ownership verification service (DB-backed, replaces Haiku-era stub).

Responsibilities:

* Mint a challenge row for a (user, device_ip) tuple under one of three
  proof methods (PIN display, MAC/serial readback, signed attestation).
* Verify responses in constant time, atomically bump attempt counters,
  and lock the row out after ``max_attempts`` failed attempts.
* Provide a ``consume`` primitive that the claim pipeline calls exactly
  once — a verified row can pair exactly one device, after which it is
  marked ``consumed`` and is no longer replayable.
* Emit structured audit events on every state transition.

The previous version held state in an in-memory dict on a singleton
service. That was unsafe for multiple uvicorn workers, lost state on
restart, and produced no audit trail. Everything here lives in
Postgres.
"""

from __future__ import annotations

import hmac
import secrets
from dataclasses import dataclass
from datetime import timedelta
from hashlib import sha256
from typing import Any

from sqlalchemy import and_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import get_settings
from app.crypto.attestation import verify_signed_attestation
from app.db.models.device_ownership import (
    DeviceOwnershipAudit,
    DeviceOwnershipAuditEvent,
    DeviceOwnershipChallenge,
    OwnershipChallengeMethod,
    OwnershipChallengeStatus,
)
from app.db.session import transactional
from app.exceptions import (
    ConflictError,
    NotFoundError,
    PermissionError_,
    ValidationError_,
)
from app.logging_setup import get_logger
from app.utils.ids import new_ulid
from app.utils.time import utcnow

log = get_logger("device_ownership")


# ── Tunables ────────────────────────────────────────────────────────────

# How long a single challenge stays answerable.
CHALLENGE_TTL_SECONDS = 5 * 60

# After this many failed attempts the row goes into ``locked`` and the
# user has to start over.
MAX_ATTEMPTS_DEFAULT = 5

# Per-user concurrency cap on *pending* challenges. Prevents a hostile
# user from spamming us with thousands of half-open challenges.
MAX_PENDING_PER_USER = 8

# Per-(user, device_ip) cooldown — once an entry is ``locked`` we refuse
# to mint a new one until this much time has elapsed.
LOCKOUT_COOLDOWN_SECONDS = 10 * 60


# ── Result types ────────────────────────────────────────────────────────

@dataclass(slots=True)
class ChallengeContext:
    """Where the request came from — populated by the API layer."""

    requester_ip: str | None = None
    requester_user_agent: str | None = None


@dataclass(slots=True)
class IssuedChallenge:
    row: DeviceOwnershipChallenge
    rendered_pin: str | None  # only set for dev mode PIN flows
    delivery_hint: str | None


@dataclass(slots=True)
class VerifyOutcome:
    row: DeviceOwnershipChallenge
    verified: bool
    message: str


# ── Service ─────────────────────────────────────────────────────────────

class DeviceOwnershipService:
    """Stateless façade over the Postgres tables.

    Every public coroutine opens its own ``transactional`` block so the
    caller never has to think about consistency between the challenge
    row and its audit event.
    """

    def __init__(self) -> None:
        self.settings = get_settings()

    # ── 1. issue a challenge ────────────────────────────────────────

    async def issue(
        self,
        session: AsyncSession,
        *,
        user_id: str,
        device_ip: str,
        method: OwnershipChallengeMethod,
        device_mac: str | None = None,
        expected_mac: str | None = None,
        expected_serial: str | None = None,
        public_key_pem: str | None = None,
        ctx: ChallengeContext | None = None,
    ) -> IssuedChallenge:
        ctx = ctx or ChallengeContext()
        await self._enforce_pending_quota(session, user_id=user_id)
        await self._enforce_lockout(
            session, user_id=user_id, device_ip=device_ip,
        )

        nonce = secrets.token_urlsafe(24)
        rendered_pin: str | None = None
        pin_hash: str | None = None
        pin_salt: str | None = None
        delivery_hint: str | None = None

        if method is OwnershipChallengeMethod.pin_display:
            rendered_pin = f"{secrets.randbelow(1_000_000):06d}"
            pin_salt = secrets.token_hex(16)
            pin_hash = self._hash_pin(rendered_pin, pin_salt)
            delivery_hint = (
                "the consumer agent must push this PIN to the device "
                "(vendor channel) so the user can read it back"
            )
        elif method is OwnershipChallengeMethod.mac_serial:
            if not expected_mac:
                raise ValidationError_(
                    "mac_serial method requires expected_mac from a recent scan"
                )
            delivery_hint = (
                "ask the user to find the MAC (and optional serial) in the "
                "device's own admin UI and type it back"
            )
        elif method is OwnershipChallengeMethod.signed_attestation:
            if not public_key_pem:
                raise ValidationError_(
                    "signed_attestation method requires public_key_pem"
                )
            delivery_hint = (
                "the device must sign the nonce with its private key and "
                "POST the hex signature back"
            )
        else:  # pragma: no cover — pydantic guards this
            raise ValidationError_(f"unsupported ownership method: {method}")

        async with transactional(session):
            await self._gc_expired(session, user_id=user_id, device_ip=device_ip)
            row = DeviceOwnershipChallenge(
                id=new_ulid(),
                user_id=user_id,
                device_ip=device_ip,
                device_mac=device_mac,
                expected_mac=self._canon_mac(expected_mac),
                expected_serial=(expected_serial or None),
                method=method,
                status=OwnershipChallengeStatus.pending,
                nonce=nonce,
                pin_hash=pin_hash,
                pin_salt=pin_salt,
                public_key_pem=public_key_pem,
                expires_at=utcnow() + timedelta(seconds=CHALLENGE_TTL_SECONDS),
                attempts=0,
                max_attempts=MAX_ATTEMPTS_DEFAULT,
                requester_ip=ctx.requester_ip,
                requester_user_agent=ctx.requester_user_agent,
                delivery={"hint": delivery_hint} if delivery_hint else {},
            )
            session.add(row)
            await session.flush()
            await self._audit(
                session,
                challenge_id=row.id,
                user_id=user_id,
                device_ip=device_ip,
                event=DeviceOwnershipAuditEvent.challenge_created,
                detail={"method": method.value},
            )

        log.info(
            "device_ownership.issued",
            challenge_id=row.id,
            user_id=user_id,
            device_ip=device_ip,
            method=method.value,
        )

        return IssuedChallenge(
            row=row,
            rendered_pin=(
                rendered_pin
                if rendered_pin is not None and self._show_pin_to_client()
                else None
            ),
            delivery_hint=delivery_hint,
        )

    # ── 2. verify a response ────────────────────────────────────────

    async def respond(
        self,
        session: AsyncSession,
        *,
        user_id: str,
        challenge_id: str,
        pin: str | None = None,
        mac: str | None = None,
        serial: str | None = None,
        signature_hex: str | None = None,
    ) -> VerifyOutcome:
        async with transactional(session):
            row = await session.get(
                DeviceOwnershipChallenge,
                challenge_id,
                with_for_update=True,
            )
            if row is None or row.user_id != user_id:
                raise NotFoundError("challenge not found")

            now = utcnow()
            if row.status is OwnershipChallengeStatus.verified:
                return VerifyOutcome(
                    row=row, verified=True,
                    message="already verified — POST /respond is idempotent",
                )
            if row.status is not OwnershipChallengeStatus.pending:
                raise ConflictError(
                    f"challenge is in terminal state {row.status.value}"
                )
            if row.expires_at <= now:
                row.status = OwnershipChallengeStatus.expired
                await self._audit(
                    session,
                    challenge_id=row.id,
                    user_id=user_id,
                    device_ip=row.device_ip,
                    event=DeviceOwnershipAuditEvent.challenge_expired,
                )
                raise PermissionError_("challenge expired — start a new one")

            row.attempts += 1
            ok, why = self._verify_payload(row, pin=pin, mac=mac,
                                           serial=serial,
                                           signature_hex=signature_hex)

            if ok:
                row.status = OwnershipChallengeStatus.verified
                row.verified_at = now
                # Strip the PIN material once it has done its job — it
                # cannot be presented twice.
                row.pin_hash = None
                row.pin_salt = None
                await self._audit(
                    session,
                    challenge_id=row.id,
                    user_id=user_id,
                    device_ip=row.device_ip,
                    event=DeviceOwnershipAuditEvent.response_accepted,
                    detail={"attempts": row.attempts},
                )
                log.info(
                    "device_ownership.verified",
                    challenge_id=row.id,
                    user_id=user_id,
                    device_ip=row.device_ip,
                    method=row.method.value,
                    attempts=row.attempts,
                )
                return VerifyOutcome(
                    row=row, verified=True,
                    message="ownership verified",
                )

            await self._audit(
                session,
                challenge_id=row.id,
                user_id=user_id,
                device_ip=row.device_ip,
                event=DeviceOwnershipAuditEvent.response_rejected,
                detail={"attempts": row.attempts, "reason": why},
            )

            if row.attempts >= row.max_attempts:
                row.status = OwnershipChallengeStatus.locked
                await self._audit(
                    session,
                    challenge_id=row.id,
                    user_id=user_id,
                    device_ip=row.device_ip,
                    event=DeviceOwnershipAuditEvent.challenge_locked,
                    detail={"attempts": row.attempts},
                )
                log.warning(
                    "device_ownership.locked",
                    challenge_id=row.id,
                    user_id=user_id,
                    device_ip=row.device_ip,
                    attempts=row.attempts,
                )
                raise PermissionError_(
                    "too many failed attempts — challenge is locked, "
                    f"retry in {LOCKOUT_COOLDOWN_SECONDS // 60} minutes",
                )

            remaining = row.max_attempts - row.attempts
            raise ValidationError_(
                f"{why} — {remaining} attempt(s) left",
                detail={"attempts_remaining": remaining},
            )

    # ── 3. consume on claim ─────────────────────────────────────────

    async def consume(
        self,
        session: AsyncSession,
        *,
        user_id: str,
        device_ip: str,
    ) -> DeviceOwnershipChallenge | None:
        """Find the freshest ``verified`` row for (user, device_ip) and
        mark it ``consumed``.  Returns the row when one was burned, or
        ``None`` if there is no verified challenge to spend.
        """

        async with transactional(session):
            row = await self._latest_verified(
                session, user_id=user_id, device_ip=device_ip,
                lock=True,
            )
            if row is None:
                return None
            row.status = OwnershipChallengeStatus.consumed
            row.consumed_at = utcnow()
            await self._audit(
                session,
                challenge_id=row.id,
                user_id=user_id,
                device_ip=device_ip,
                event=DeviceOwnershipAuditEvent.verification_consumed,
            )
            log.info(
                "device_ownership.consumed",
                challenge_id=row.id,
                user_id=user_id,
                device_ip=device_ip,
            )
            return row

    async def is_verified(
        self,
        session: AsyncSession,
        *,
        user_id: str,
        device_ip: str,
    ) -> bool:
        row = await self._latest_verified(
            session, user_id=user_id, device_ip=device_ip,
        )
        return row is not None

    # ── 4. cancel / status ──────────────────────────────────────────

    async def cancel(
        self,
        session: AsyncSession,
        *,
        user_id: str,
        challenge_id: str,
    ) -> DeviceOwnershipChallenge:
        async with transactional(session):
            row = await session.get(DeviceOwnershipChallenge, challenge_id)
            if row is None or row.user_id != user_id:
                raise NotFoundError("challenge not found")
            if row.is_terminal:
                return row
            row.status = OwnershipChallengeStatus.cancelled
            await self._audit(
                session,
                challenge_id=row.id,
                user_id=user_id,
                device_ip=row.device_ip,
                event=DeviceOwnershipAuditEvent.challenge_cancelled,
            )
            return row

    async def status_for(
        self,
        session: AsyncSession,
        *,
        user_id: str,
        device_ip: str,
    ) -> DeviceOwnershipChallenge | None:
        """Return the freshest non-terminal challenge, otherwise the
        freshest verified one."""

        now = utcnow()
        # Prefer an active pending row.
        stmt = (
            select(DeviceOwnershipChallenge)
            .where(
                and_(
                    DeviceOwnershipChallenge.user_id == user_id,
                    DeviceOwnershipChallenge.device_ip == device_ip,
                    DeviceOwnershipChallenge.status
                    == OwnershipChallengeStatus.pending,
                    DeviceOwnershipChallenge.expires_at > now,
                )
            )
            .order_by(DeviceOwnershipChallenge.created_at.desc())
            .limit(1)
        )
        row = (await session.execute(stmt)).scalar_one_or_none()
        if row is not None:
            return row
        return await self._latest_verified(
            session, user_id=user_id, device_ip=device_ip,
        )

    # ── internals ───────────────────────────────────────────────────

    def _verify_payload(
        self,
        row: DeviceOwnershipChallenge,
        *,
        pin: str | None,
        mac: str | None,
        serial: str | None,
        signature_hex: str | None,
    ) -> tuple[bool, str]:
        if row.method is OwnershipChallengeMethod.pin_display:
            if not pin:
                return False, "missing pin"
            if row.pin_hash is None or row.pin_salt is None:
                return False, "challenge has no pin material"
            candidate = self._hash_pin(pin.strip(), row.pin_salt)
            if hmac.compare_digest(candidate, row.pin_hash):
                return True, ""
            return False, "incorrect pin"

        if row.method is OwnershipChallengeMethod.mac_serial:
            if not mac:
                return False, "missing mac"
            if not row.expected_mac:
                return False, "challenge has no expected mac"
            if not hmac.compare_digest(
                self._canon_mac(mac), row.expected_mac,
            ):
                return False, "mac mismatch"
            if row.expected_serial and (
                not serial
                or not hmac.compare_digest(
                    serial.strip().lower(),
                    row.expected_serial.strip().lower(),
                )
            ):
                return False, "serial mismatch"
            return True, ""

        if row.method is OwnershipChallengeMethod.signed_attestation:
            if not signature_hex or not row.public_key_pem:
                return False, "missing signature"
            try:
                ok = verify_signed_attestation(
                    public_key_pem=row.public_key_pem,
                    challenge_nonce=row.nonce,
                    signature_hex=signature_hex,
                )
            except Exception as exc:
                return False, f"signature error: {exc}"
            if ok:
                return True, ""
            return False, "invalid signature"

        return False, f"unsupported method {row.method}"  # pragma: no cover

    def _hash_pin(self, pin: str, salt: str) -> str:
        return sha256(f"{salt}:{pin}".encode()).hexdigest()

    def _canon_mac(self, mac: str | None) -> str | None:
        if mac is None:
            return None
        return (
            mac.replace("-", "")
            .replace(":", "")
            .replace(".", "")
            .strip()
            .lower()
        )

    async def _latest_verified(
        self,
        session: AsyncSession,
        *,
        user_id: str,
        device_ip: str,
        lock: bool = False,
    ) -> DeviceOwnershipChallenge | None:
        stmt = (
            select(DeviceOwnershipChallenge)
            .where(
                and_(
                    DeviceOwnershipChallenge.user_id == user_id,
                    DeviceOwnershipChallenge.device_ip == device_ip,
                    DeviceOwnershipChallenge.status
                    == OwnershipChallengeStatus.verified,
                )
            )
            .order_by(DeviceOwnershipChallenge.verified_at.desc())
            .limit(1)
        )
        if lock:
            stmt = stmt.with_for_update()
        return (await session.execute(stmt)).scalar_one_or_none()

    async def _enforce_pending_quota(
        self, session: AsyncSession, *, user_id: str,
    ) -> None:
        now = utcnow()
        rows = (
            await session.execute(
                select(DeviceOwnershipChallenge).where(
                    and_(
                        DeviceOwnershipChallenge.user_id == user_id,
                        DeviceOwnershipChallenge.status
                        == OwnershipChallengeStatus.pending,
                        DeviceOwnershipChallenge.expires_at > now,
                    )
                )
            )
        ).scalars().all()
        if len(rows) >= MAX_PENDING_PER_USER:
            raise ConflictError(
                f"you already have {len(rows)} pending ownership "
                f"challenges (cap={MAX_PENDING_PER_USER}) — finish or "
                f"cancel one before starting another",
            )

    async def _enforce_lockout(
        self,
        session: AsyncSession,
        *,
        user_id: str,
        device_ip: str,
    ) -> None:
        cooldown_floor = utcnow() - timedelta(seconds=LOCKOUT_COOLDOWN_SECONDS)
        latest_locked = (
            await session.execute(
                select(DeviceOwnershipChallenge)
                .where(
                    and_(
                        DeviceOwnershipChallenge.user_id == user_id,
                        DeviceOwnershipChallenge.device_ip == device_ip,
                        DeviceOwnershipChallenge.status
                        == OwnershipChallengeStatus.locked,
                        DeviceOwnershipChallenge.updated_at > cooldown_floor,
                    )
                )
                .order_by(DeviceOwnershipChallenge.updated_at.desc())
                .limit(1)
            )
        ).scalar_one_or_none()
        if latest_locked is not None:
            remaining = int(
                LOCKOUT_COOLDOWN_SECONDS
                - (utcnow() - latest_locked.updated_at).total_seconds()
            )
            raise PermissionError_(
                "this device is locked from ownership attempts",
                detail={"retry_after_seconds": max(remaining, 1)},
            )

    async def _gc_expired(
        self,
        session: AsyncSession,
        *,
        user_id: str,
        device_ip: str,
    ) -> None:
        now = utcnow()
        rows = (
            await session.execute(
                select(DeviceOwnershipChallenge).where(
                    and_(
                        DeviceOwnershipChallenge.user_id == user_id,
                        DeviceOwnershipChallenge.device_ip == device_ip,
                        DeviceOwnershipChallenge.status
                        == OwnershipChallengeStatus.pending,
                        DeviceOwnershipChallenge.expires_at <= now,
                    )
                )
            )
        ).scalars().all()
        for r in rows:
            r.status = OwnershipChallengeStatus.expired

    async def _audit(
        self,
        session: AsyncSession,
        *,
        challenge_id: str | None,
        user_id: str | None,
        device_ip: str | None,
        event: DeviceOwnershipAuditEvent,
        detail: dict[str, Any] | None = None,
    ) -> None:
        session.add(
            DeviceOwnershipAudit(
                id=new_ulid(),
                challenge_id=challenge_id,
                user_id=user_id,
                device_ip=device_ip,
                event=event,
                detail=detail or {},
            )
        )

    def _show_pin_to_client(self) -> bool:
        """Mirror :attr:`Settings.lan_claim_dev_show_otp`.

        In production the PIN is delivered out-of-band via the vendor
        push channel and we refuse to echo it back to the renderer.
        """

        return bool(getattr(self.settings, "lan_claim_dev_show_otp", False))


# ── Singleton ───────────────────────────────────────────────────────────

_SERVICE: DeviceOwnershipService | None = None


def get_device_ownership_service() -> DeviceOwnershipService:
    global _SERVICE
    if _SERVICE is None:
        _SERVICE = DeviceOwnershipService()
    return _SERVICE
