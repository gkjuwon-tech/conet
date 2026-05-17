from __future__ import annotations

import hashlib
import secrets
from dataclasses import dataclass
from datetime import timedelta
from typing import Any

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import get_settings
from app.db.models.lan_claim import LanClaim, LanClaimStatus
from app.db.models.user import User
from app.db.session import transactional
from app.exceptions import (
    AuthError,
    ConflictError,
    NotFoundError,
    PermissionError_,
)
from app.logging_setup import get_logger
from app.utils.ids import new_ulid
from app.utils.time import utcnow


log = get_logger("lan_claim")


@dataclass(slots=True)
class ClaimRequestOutcome:
    claim: LanClaim
    otp: str | None  # only populated in dev mode (lan_claim_dev_show_otp)


class LanClaimService:
    def __init__(self) -> None:
        self.settings = get_settings()

    async def request_claim(
        self,
        session: AsyncSession,
        *,
        user: User,
        lan_fingerprint: str,
        gateway_ip: str | None,
        gateway_mac: str | None,
        advertised_subnet: str | None,
        label: str | None,
        ip: str | None,
        user_agent: str | None,
    ) -> ClaimRequestOutcome:
        await self._enforce_account_age(user)
        await self._enforce_user_quota(session, user)

        async with transactional(session):
            existing = await self._get_user_claim(session, user.id, lan_fingerprint)
            otp_plain = self._generate_otp()
            otp_hash = self._hash_otp(otp_plain)
            ttl = self.settings.lan_claim_otp_ttl_seconds
            now = utcnow()

            if existing is None:
                claim = LanClaim(
                    id=new_ulid(),
                    user_id=user.id,
                    lan_fingerprint=lan_fingerprint,
                    status=LanClaimStatus.pending_otp,
                    otp_hash=otp_hash,
                    otp_expires_at=now + timedelta(seconds=ttl),
                    otp_attempts=0,
                    requested_ip=ip,
                    requested_user_agent=user_agent,
                    gateway_ip=gateway_ip,
                    gateway_mac=gateway_mac,
                    advertised_subnet=advertised_subnet,
                    label=label,
                )
                session.add(claim)
            else:
                if existing.status == LanClaimStatus.verified:
                    raise ConflictError("LAN already claimed by you")
                if existing.status == LanClaimStatus.disputed:
                    raise ConflictError("LAN claim is currently disputed")
                claim = existing
                claim.status = LanClaimStatus.pending_otp
                claim.otp_hash = otp_hash
                claim.otp_expires_at = now + timedelta(seconds=ttl)
                claim.otp_attempts = 0
                claim.gateway_ip = gateway_ip or claim.gateway_ip
                claim.gateway_mac = gateway_mac or claim.gateway_mac
                claim.advertised_subnet = advertised_subnet or claim.advertised_subnet
                claim.label = label or claim.label
                claim.requested_ip = ip
                claim.requested_user_agent = user_agent

            await session.flush()

        # In a real deployment, this is where we'd queue an email / SMS.
        log.info(
            "lan_claim.otp_issued",
            user_id=user.id,
            email=user.email,
            lan_fingerprint=lan_fingerprint,
            otp=otp_plain,
            ttl_seconds=ttl,
        )

        return ClaimRequestOutcome(
            claim=claim,
            otp=otp_plain if self.settings.lan_claim_dev_show_otp else None,
        )

    async def verify_claim(
        self,
        session: AsyncSession,
        *,
        user: User,
        lan_fingerprint: str,
        otp: str,
    ) -> LanClaim:
        async with transactional(session):
            claim = await self._get_user_claim(session, user.id, lan_fingerprint)
            if claim is None:
                raise NotFoundError("no pending claim for this LAN")

            if claim.status == LanClaimStatus.verified:
                return claim
            if claim.status not in (
                LanClaimStatus.pending_otp,
                LanClaimStatus.expired,
            ):
                raise ConflictError(f"claim is in {claim.status.value}")

            now = utcnow()
            if claim.otp_expires_at and claim.otp_expires_at < now:
                claim.status = LanClaimStatus.expired
                raise AuthError("OTP expired — request a new one")

            if claim.otp_attempts >= self.settings.lan_claim_otp_max_attempts:
                claim.status = LanClaimStatus.expired
                raise AuthError("too many attempts — request a new OTP")

            claim.otp_attempts += 1

            if not claim.otp_hash or claim.otp_hash != self._hash_otp(otp.strip()):
                raise AuthError("invalid OTP")

            claim.status = LanClaimStatus.verified
            claim.verified_at = now
            claim.grace_until = now + timedelta(seconds=self.settings.lan_claim_grace_seconds)
            claim.otp_hash = None

            log.info(
                "lan_claim.verified",
                user_id=user.id,
                lan_fingerprint=lan_fingerprint,
                claim_id=claim.id,
            )
            return claim

    async def assert_user_can_register_on_lan(
        self,
        session: AsyncSession,
        *,
        user_id: str,
        lan_fingerprint: str | None,
    ) -> LanClaim | None:
        if not lan_fingerprint:
            raise PermissionError_(
                "device registration requires a lan_fingerprint",
                detail={"hint": "the consumer agent must compute a fingerprint"},
            )
        claim = await self._get_user_claim(session, user_id, lan_fingerprint)
        if claim is None or claim.status != LanClaimStatus.verified or not claim.is_active:
            raise PermissionError_(
                "this LAN is not claimed by you — run `em lan claim` (CLI) or use the in-app LAN wizard",
                detail={"lan_fingerprint": lan_fingerprint},
            )
        return claim

    async def list_for_user(self, session: AsyncSession, user_id: str) -> list[LanClaim]:
        result = await session.execute(
            select(LanClaim)
            .where(LanClaim.user_id == user_id)
            .order_by(LanClaim.created_at.desc())
        )
        return list(result.scalars())

    async def revoke(
        self, session: AsyncSession, *, user: User, claim_id: str
    ) -> LanClaim:
        async with transactional(session):
            claim = await session.get(LanClaim, claim_id)
            if claim is None or claim.user_id != user.id:
                raise NotFoundError("claim not found")
            claim.status = LanClaimStatus.revoked
            claim.revoked_at = utcnow()
            claim.is_active = False
            return claim

    async def dispute(
        self,
        session: AsyncSession,
        *,
        disputing_user: User,
        lan_fingerprint: str,
        reason: str,
    ) -> dict[str, Any]:
        async with transactional(session):
            now = utcnow()
            held = (await session.execute(
                select(LanClaim).where(
                    LanClaim.lan_fingerprint == lan_fingerprint,
                    LanClaim.status == LanClaimStatus.verified,
                )
            )).scalars().all()

            disputed_count = 0
            for claim in held:
                if claim.user_id == disputing_user.id:
                    continue
                claim.status = LanClaimStatus.disputed
                claim.is_active = False
                claim.metadata_ = {
                    **(claim.metadata_ or {}),
                    "disputed_by": disputing_user.id,
                    "disputed_at": now.isoformat(),
                    "dispute_reason": reason[:512],
                }
                disputed_count += 1
                log.warning(
                    "lan_claim.disputed",
                    claim_id=claim.id,
                    held_by=claim.user_id,
                    disputed_by=disputing_user.id,
                    lan_fingerprint=lan_fingerprint,
                )
            return {"disputed": disputed_count}

    # ---- internals ----

    async def _enforce_account_age(self, user: User) -> None:
        min_age = self.settings.lan_claim_account_min_age_seconds
        if min_age <= 0:
            return
        age = (utcnow() - user.created_at).total_seconds() if user.created_at else 0
        if age < min_age:
            raise PermissionError_(
                "your account is too new to claim a LAN",
                detail={
                    "account_age_seconds": int(age),
                    "min_age_seconds": min_age,
                    "hint": "verify your email and try again later",
                },
            )

    async def _enforce_user_quota(self, session: AsyncSession, user: User) -> None:
        cap = self.settings.lan_claim_max_per_user
        active = (await session.execute(
            select(func.count(LanClaim.id)).where(
                LanClaim.user_id == user.id,
                LanClaim.status == LanClaimStatus.verified,
                LanClaim.is_active.is_(True),
            )
        )).scalar_one() or 0
        if active >= cap:
            raise ConflictError(
                f"you already hold the max {cap} verified LAN claims",
                detail={"active": int(active), "limit": cap},
            )

    async def _get_user_claim(
        self, session: AsyncSession, user_id: str, lan_fingerprint: str
    ) -> LanClaim | None:
        result = await session.execute(
            select(LanClaim).where(
                LanClaim.user_id == user_id,
                LanClaim.lan_fingerprint == lan_fingerprint,
            )
        )
        return result.scalar_one_or_none()

    def _generate_otp(self) -> str:
        # 6 digit numeric — easy to type, type matched in support flows.
        return f"{secrets.randbelow(1_000_000):06d}"

    def _hash_otp(self, otp: str) -> str:
        return hashlib.sha256(otp.encode("utf-8")).hexdigest()
