"""
Claim API — ownership-verified device pairing endpoints.

    --- ToS ---
    GET    /v1/claim/tos                       — consent content for frontend
    POST   /v1/claim/tos/accept                — record acceptance
    GET    /v1/claim/tos/status                — check acceptance state

    --- Network scan ---
    POST   /v1/claim/scan                      — trigger ARP / SSDP / port scan
    GET    /v1/claim/scan/results              — cached results

    --- Claim execution (requires verified ownership) ---
    POST   /v1/claim/execute                   — claim a single device
    POST   /v1/claim/execute-all               — claim every non-gateway host
    GET    /v1/claim/fleet                     — fleet status
    POST   /v1/claim/release/{ip}              — release a device

Ownership verification has been split out into its own router under
``/v1/devices/ownership/*`` (see :mod:`app.api.v1.device_ownership`).
"""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends, status
from pydantic import BaseModel, Field
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.dependencies import Principal, require_user
from app.db.session import get_session
from app.exceptions import ValidationError_
from app.services.claim_service import get_claim_service
from app.services.tos_service import get_tos_service

router = APIRouter(prefix="/claim", tags=["claim"])


# ── helpers ───────────────────────────────────────────────────────────────

async def _require_tos(session: AsyncSession, user_id: str) -> None:
    """Raise 403 if the user has not accepted the current ToS version."""
    tos = get_tos_service()
    check = await tos.check(session, user_id=user_id)
    if not check.get("accepted"):
        raise ValidationError_("ToS not accepted — POST /v1/claim/tos/accept first").as_http()


# ── ToS ───────────────────────────────────────────────────────────────────

@router.get("/tos")
async def get_tos() -> dict[str, Any]:
    return get_tos_service().get_tos_content()


@router.post("/tos/accept")
async def accept_tos(
    principal: Principal = Depends(require_user),
    session: AsyncSession = Depends(get_session),
) -> dict[str, Any]:
    return await get_tos_service().accept(session, user_id=principal.user.id)


@router.get("/tos/status")
async def tos_status(
    principal: Principal = Depends(require_user),
    session: AsyncSession = Depends(get_session),
) -> dict[str, Any]:
    return await get_tos_service().check(session, user_id=principal.user.id)


# ── Scan ──────────────────────────────────────────────────────────────────

class ScanRequest(BaseModel):
    force: bool = Field(default=False)


@router.post("/scan")
async def scan_network(
    payload: ScanRequest = ScanRequest(),
    principal: Principal = Depends(require_user),
    session: AsyncSession = Depends(get_session),
) -> dict[str, Any]:
    await _require_tos(session, principal.user.id)
    devices = await get_claim_service().scan(force=payload.force)
    return {"devices": devices, "count": len(devices)}


@router.get("/scan/results")
async def get_scan_results(
    principal: Principal = Depends(require_user),
) -> dict[str, Any]:
    devices = get_claim_service().get_scan_results()
    return {"devices": devices, "count": len(devices)}


# ── Ingest (client-side scan results) ─────────────────────────────────────

class IngestDevice(BaseModel):
    """One device the desktop app discovered on the user's LAN.

    Mirrors :class:`app.services.network_scanner.DeviceFingerprint` so the
    ingest payload populates the same scanner cache that
    ``/v1/claim/execute`` reads from when it dispatches a claim vector.
    """
    ip: str = Field(..., max_length=45)
    mac: str = Field(default="", max_length=17)
    hostname: str | None = Field(default=None, max_length=255)
    vendor: str = Field(default="Unknown", max_length=64)
    device_class: str = Field(default="device", max_length=32)
    is_gateway: bool = Field(default=False)
    randomized_mac: bool = Field(default=False)
    is_self: bool = Field(default=False)


class ScanIngestRequest(BaseModel):
    lan_fingerprint: str = Field(..., max_length=64)
    gateway_ip: str = Field(default="", max_length=45)
    gateway_mac: str = Field(default="", max_length=17)
    subnet: str = Field(default="", max_length=64)
    devices: list[IngestDevice]


@router.post("/scan/ingest")
async def ingest_scan(
    payload: ScanIngestRequest,
    principal: Principal = Depends(require_user),
    session: AsyncSession = Depends(get_session),
) -> dict[str, Any]:
    """Accept a desktop-side LAN scan and populate the scanner cache.

    The conet backend runs in a Docker bridge network, so the in-container
    scanner can't ARP the user's physical LAN. The Electron main process
    discovers devices on the host side and posts them here so that the rest
    of the claim flow (which reads from this cache) keeps working.
    """
    await _require_tos(session, principal.user.id)
    accepted = await get_claim_service().ingest_scan_results(payload.devices)
    return {
        "accepted": accepted,
        "lan_fingerprint": payload.lan_fingerprint,
    }


# ── Execute ───────────────────────────────────────────────────────────────

class LanContextBody(BaseModel):
    """Host-side LAN identity — the CLI/desktop reports the user's own
    machine info for logging / scan-attribution purposes. The backend does
    NOT use this to bring up any L2 infrastructure; all such modes have
    been removed."""
    our_ip: str = Field(default="", max_length=45)
    our_mac: str = Field(default="", max_length=17)
    gateway_ip: str = Field(default="", max_length=45)
    gateway_mac: str = Field(default="", max_length=17)
    interface: str = Field(default="", max_length=64)


def _to_ctx(body: LanContextBody | None):
    from app.services.claim_service import LanContext
    if body is None:
        return LanContext()
    return LanContext(
        our_ip=body.our_ip, our_mac=body.our_mac,
        gateway_ip=body.gateway_ip, gateway_mac=body.gateway_mac,
        interface=body.interface,
    )


class ClaimRequest(BaseModel):
    target_ip: str = Field(..., max_length=45)
    lan_fingerprint: str = Field(..., max_length=64)
    lan_context: LanContextBody | None = None


@router.post("/execute", status_code=status.HTTP_201_CREATED)
async def execute_claim(
    payload: ClaimRequest,
    principal: Principal = Depends(require_user),
    session: AsyncSession = Depends(get_session),
) -> dict[str, Any]:
    """Claim a single device using its optimal attack vector."""
    await _require_tos(session, principal.user.id)
    result = await get_claim_service().execute_claim(
        session,
        user_id=principal.user.id,
        target_ip=payload.target_ip,
        lan_fingerprint=payload.lan_fingerprint,
        ctx=_to_ctx(payload.lan_context),
    )
    return result.to_dict()


class ClaimAllRequest(BaseModel):
    lan_fingerprint: str = Field(..., max_length=64)
    lan_context: LanContextBody | None = None


@router.post("/execute-all", status_code=status.HTTP_201_CREATED)
async def execute_claim_all(
    payload: ClaimAllRequest,
    principal: Principal = Depends(require_user),
    session: AsyncSession = Depends(get_session),
) -> dict[str, Any]:
    """Claim every non-gateway device found during the last scan."""
    await _require_tos(session, principal.user.id)
    results = await get_claim_service().execute_claim_all(
        session,
        user_id=principal.user.id,
        lan_fingerprint=payload.lan_fingerprint,
        ctx=_to_ctx(payload.lan_context),
    )
    return {
        "results": [r.to_dict() for r in results],
        "total": len(results),
        "succeeded": sum(1 for r in results if r.success),
        "failed": sum(1 for r in results if not r.success),
    }


# ── Fleet ─────────────────────────────────────────────────────────────────

@router.get("/fleet")
async def fleet_status(
    principal: Principal = Depends(require_user),
) -> dict[str, Any]:
    return get_claim_service().get_fleet_status()


@router.post("/release/{target_ip}")
async def release_device(
    target_ip: str,
    principal: Principal = Depends(require_user),
) -> dict[str, Any]:
    return await get_claim_service().release(target_ip)


# ── legacy ownership shims ────────────────────────────────────────────────
#
# The old desktop builds in the field POST to ``/v1/claim/ownership/*``
# (the in-memory family we replaced). These shims keep them working so
# users on stale installs don't get bricked the moment they "Update"
# is hit. They proxy to the new DB-backed service under
# ``/v1/devices/ownership/*`` and stamp a ``Deprecation`` header.

from fastapi import Response

from app.db.models.device_ownership import (
    OwnershipChallengeMethod,
    OwnershipChallengeStatus,
)
from app.schemas.device_ownership import (
    LegacyChallengeStartResponse,
    LegacyMacVerifyRequest,
    LegacyPinChallengeRequest,
    LegacyPinVerifyRequest,
    LegacyVerifyResponse,
)
from app.services.device_ownership import (
    CHALLENGE_TTL_SECONDS,
    ChallengeContext,
    get_device_ownership_service,
)


_DEPRECATION_HEADERS = {
    "Deprecation": "true",
    "Sunset": "Wed, 31 Dec 2025 00:00:00 GMT",
    "Link": '</v1/devices/ownership/challenge>; rel="successor-version"',
    "Warning": (
        '299 - "/v1/claim/ownership/* is deprecated. '
        'Use /v1/devices/ownership/* (challenge + respond + status). '
        'The legacy shim will be removed 2026-01."'
    ),
}


@router.post(
    "/ownership/start-pin",
    response_model=LegacyChallengeStartResponse,
    status_code=status.HTTP_200_OK,
    deprecated=True,
    summary="DEPRECATED — use POST /v1/devices/ownership/challenge with method=pin_display",
)
async def legacy_start_pin(
    payload: LegacyPinChallengeRequest,
    response: Response,
    principal: Principal = Depends(require_user),
    session: AsyncSession = Depends(get_session),
) -> LegacyChallengeStartResponse:
    await _require_tos(session, principal.user.id)
    service = get_device_ownership_service()
    issued = await service.issue(
        session,
        user_id=principal.user.id,
        device_ip=payload.device_ip,
        method=OwnershipChallengeMethod.pin_display,
        ctx=ChallengeContext(),
    )
    response.headers.update(_DEPRECATION_HEADERS)
    return LegacyChallengeStartResponse(
        challenge_id=issued.row.id,
        challenge_type="pin_display",
        expires_in_seconds=CHALLENGE_TTL_SECONDS,
        pin_visible_to_user=True,
        pin=issued.rendered_pin,
    )


@router.post(
    "/ownership/verify-pin",
    response_model=LegacyVerifyResponse,
    deprecated=True,
    summary="DEPRECATED — use POST /v1/devices/ownership/respond with {challenge_id, pin}",
)
async def legacy_verify_pin(
    payload: LegacyPinVerifyRequest,
    response: Response,
    principal: Principal = Depends(require_user),
    session: AsyncSession = Depends(get_session),
) -> LegacyVerifyResponse:
    await _require_tos(session, principal.user.id)
    service = get_device_ownership_service()
    # Legacy clients identify challenges by IP, not id. Resolve the active
    # pending challenge for this (user, ip) tuple — if none, the caller
    # forgot to /start-pin first.
    row = await service.status_for(
        session, user_id=principal.user.id, device_ip=payload.device_ip,
    )
    if row is None or row.status != OwnershipChallengeStatus.pending:
        raise ValidationError_(
            "no active PIN challenge for this device — call /v1/claim/ownership/start-pin first"
        ).as_http()
    outcome = await service.respond(
        session,
        user_id=principal.user.id,
        challenge_id=row.id,
        pin=payload.pin,
    )
    response.headers.update(_DEPRECATION_HEADERS)
    return LegacyVerifyResponse(
        ok=outcome.verified,
        device_ip=payload.device_ip,
        verified=outcome.verified,
        message=outcome.message,
    )


@router.post(
    "/ownership/verify-mac",
    response_model=LegacyVerifyResponse,
    deprecated=True,
    summary="DEPRECATED — use POST /v1/devices/ownership/challenge then /respond",
)
async def legacy_verify_mac(
    payload: LegacyMacVerifyRequest,
    response: Response,
    principal: Principal = Depends(require_user),
    session: AsyncSession = Depends(get_session),
) -> LegacyVerifyResponse:
    """Legacy MAC verification — single call that does both /challenge and /respond.

    The new API splits these so the renderer can poll status / cancel.
    Old clients call this single endpoint with the MAC, so we issue a
    fresh mac_serial challenge using the scanner's recorded MAC as the
    expected value, then immediately respond with the user's input.
    """
    await _require_tos(session, principal.user.id)

    from app.services.network_scanner import get_network_scanner
    scanner = get_network_scanner()
    fp = scanner.get_device(payload.device_ip)
    if fp is None or not fp.mac:
        raise ValidationError_(
            f"no scan data for {payload.device_ip} — run /v1/claim/scan first"
        ).as_http()

    service = get_device_ownership_service()
    issued = await service.issue(
        session,
        user_id=principal.user.id,
        device_ip=payload.device_ip,
        method=OwnershipChallengeMethod.mac_serial,
        expected_mac=fp.mac,
        expected_serial=payload.serial,
        ctx=ChallengeContext(),
    )
    outcome = await service.respond(
        session,
        user_id=principal.user.id,
        challenge_id=issued.row.id,
        mac=payload.mac,
        serial=payload.serial,
    )
    response.headers.update(_DEPRECATION_HEADERS)
    return LegacyVerifyResponse(
        ok=outcome.verified,
        device_ip=payload.device_ip,
        verified=outcome.verified,
        message=outcome.message,
    )
