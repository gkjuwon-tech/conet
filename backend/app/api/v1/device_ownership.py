"""Device-ownership challenge endpoints.

These are the *new* endpoints under ``/v1/devices/ownership/*`` that
replace the in-memory ``/v1/claim/ownership/*`` family. The legacy URLs
are kept as thin shims in :mod:`app.api.v1.claim` so old desktop builds
in the field continue to work while everyone upgrades.
"""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, BackgroundTasks, Depends, Request, status
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.dependencies import Principal, require_user
from app.db.models.device_ownership import OwnershipChallengeMethod
from app.db.session import get_session
from app.exceptions import ValidationError_
from app.schemas.device_ownership import (
    OwnershipChallengeCreate,
    OwnershipChallengePublic,
    OwnershipChallengeRespond,
    OwnershipStatus,
    OwnershipVerifyResult,
)
from app.services.device_ownership import (
    CHALLENGE_TTL_SECONDS,
    ChallengeContext,
    get_device_ownership_service,
)
from app.services.device_pin_delivery import deliver_pin
from app.services.tos_service import get_tos_service

router = APIRouter(prefix="/devices/ownership", tags=["device-ownership"])


async def _require_tos(session: AsyncSession, user_id: str) -> None:
    tos = get_tos_service()
    check = await tos.check(session, user_id=user_id)
    if not check.get("accepted"):
        raise ValidationError_(
            "ToS not accepted — POST /v1/claim/tos/accept first",
        ).as_http()


def _ctx_from_request(request: Request) -> ChallengeContext:
    return ChallengeContext(
        requester_ip=str(request.client.host) if request.client else None,
        requester_user_agent=request.headers.get("user-agent"),
    )


def _serialize(issued, *, expires_in_seconds: int = CHALLENGE_TTL_SECONDS) -> OwnershipChallengePublic:
    row = issued.row
    return OwnershipChallengePublic(
        challenge_id=row.id,
        device_ip=row.device_ip,
        method=row.method,
        status=row.status,
        expires_at=row.expires_at,
        attempts=row.attempts,
        max_attempts=row.max_attempts,
        rendered_pin=issued.rendered_pin,
        delivery_hint=issued.delivery_hint,
    )


@router.post(
    "/challenge",
    response_model=OwnershipChallengePublic,
    status_code=status.HTTP_201_CREATED,
)
async def create_challenge(
    payload: OwnershipChallengeCreate,
    request: Request,
    background_tasks: BackgroundTasks,
    principal: Principal = Depends(require_user),
    session: AsyncSession = Depends(get_session),
) -> OwnershipChallengePublic:
    """Open a fresh ownership challenge for one (device_ip, method) pair."""
    await _require_tos(session, principal.user.id)

    expected_mac: str | None = payload.device_mac
    from app.services.network_scanner import get_network_scanner
    scanner = get_network_scanner()
    fingerprint = scanner.get_device(payload.device_ip)

    if payload.method.value == "mac_serial" and not expected_mac:
        # Fall back to the freshest scanner reading for this IP, which is
        # exactly what the renderer cannot fake.
        if fingerprint is None or not fingerprint.mac:
            raise ValidationError_(
                f"no MAC recorded for {payload.device_ip} — run /v1/claim/scan first",
            ).as_http()
        expected_mac = fingerprint.mac

    service = get_device_ownership_service()
    try:
        issued = await service.issue(
            session,
            user_id=principal.user.id,
            device_ip=payload.device_ip,
            method=payload.method,
            device_mac=payload.device_mac,
            expected_mac=expected_mac,
            expected_serial=payload.expected_serial,
            public_key_pem=payload.public_key_pem,
            ctx=_ctx_from_request(request),
        )
    except Exception as exc:
        from app.exceptions import ElectroMeshError

        if isinstance(exc, ElectroMeshError):
            raise exc.as_http() from exc
        raise

    # For PIN challenges, fire-and-forget a delivery attempt so the PIN
    # actually shows up on the device's own screen. We don't await the
    # result — the renderer also shows the PIN to the user as a fallback,
    # and the verify endpoint doesn't care how the user obtained it.
    if (
        payload.method is OwnershipChallengeMethod.pin_display
        and issued.rendered_pin
        and fingerprint is not None
    ):
        pin_value = issued.rendered_pin
        background_tasks.add_task(_push_pin_to_device, fingerprint, pin_value)

    return _serialize(issued)


async def _push_pin_to_device(fingerprint: Any, pin: str) -> None:
    """Background task — never raises, logs everything itself."""
    try:
        await deliver_pin(fingerprint, pin)
    except Exception:
        # deliver_pin is documented as never-raising, but be belt-and-suspenders.
        pass


@router.post("/respond", response_model=OwnershipVerifyResult)
async def respond_to_challenge(
    payload: OwnershipChallengeRespond,
    principal: Principal = Depends(require_user),
    session: AsyncSession = Depends(get_session),
) -> OwnershipVerifyResult:
    """Submit the user's response (PIN / MAC / signature) and verify."""
    await _require_tos(session, principal.user.id)
    service = get_device_ownership_service()
    try:
        outcome = await service.respond(
            session,
            user_id=principal.user.id,
            challenge_id=payload.challenge_id,
            pin=payload.pin,
            mac=payload.mac,
            serial=payload.serial,
            signature_hex=payload.signature_hex,
        )
    except Exception as exc:
        from app.exceptions import ElectroMeshError

        if isinstance(exc, ElectroMeshError):
            raise exc.as_http() from exc
        raise

    row = outcome.row
    return OwnershipVerifyResult(
        challenge_id=row.id,
        device_ip=row.device_ip,
        status=row.status,
        verified=outcome.verified,
        attempts=row.attempts,
        max_attempts=row.max_attempts,
        message=outcome.message,
        verified_at=row.verified_at,
    )


@router.get("/status", response_model=OwnershipStatus)
async def get_status(
    device_ip: str,
    principal: Principal = Depends(require_user),
    session: AsyncSession = Depends(get_session),
) -> OwnershipStatus:
    """What is the latest challenge state for this device?"""
    service = get_device_ownership_service()
    row = await service.status_for(
        session, user_id=principal.user.id, device_ip=device_ip,
    )
    if row is None:
        return OwnershipStatus(
            device_ip=device_ip,
            has_active_challenge=False,
        )
    is_verified = await service.is_verified(
        session, user_id=principal.user.id, device_ip=device_ip,
    )
    return OwnershipStatus(
        device_ip=device_ip,
        has_active_challenge=row.status.value == "pending",
        challenge_id=row.id,
        method=row.method,
        status=row.status,
        expires_at=row.expires_at,
        attempts=row.attempts,
        max_attempts=row.max_attempts,
        is_verified=is_verified,
    )


@router.delete("/{challenge_id}", response_model=OwnershipChallengePublic)
async def cancel_challenge(
    challenge_id: str,
    principal: Principal = Depends(require_user),
    session: AsyncSession = Depends(get_session),
) -> OwnershipChallengePublic:
    service = get_device_ownership_service()
    try:
        row = await service.cancel(
            session, user_id=principal.user.id, challenge_id=challenge_id,
        )
    except Exception as exc:
        from app.exceptions import ElectroMeshError

        if isinstance(exc, ElectroMeshError):
            raise exc.as_http() from exc
        raise

    return OwnershipChallengePublic(
        challenge_id=row.id,
        device_ip=row.device_ip,
        method=row.method,
        status=row.status,
        expires_at=row.expires_at,
        attempts=row.attempts,
        max_attempts=row.max_attempts,
        rendered_pin=None,
        delivery_hint=None,
    )
