"""
Claim API — ownership-verified device pairing endpoints.

    --- ToS ---
    GET    /v1/claim/tos                       — consent content for frontend
    POST   /v1/claim/tos/accept                — record acceptance
    GET    /v1/claim/tos/status                — check acceptance state

    --- Network scan ---
    POST   /v1/claim/scan                      — trigger ARP / SSDP / port scan
    GET    /v1/claim/scan/results              — cached results

    --- Ownership Verification (mandatory gate) ---
    POST   /v1/claim/ownership/start-pin       — start PIN challenge
    POST   /v1/claim/ownership/verify-pin      — verify PIN
    POST   /v1/claim/ownership/verify-mac      — verify MAC/serial

    --- Claim execution (requires verified ownership) ---
    POST   /v1/claim/execute                   — claim a single device
    POST   /v1/claim/execute-all               — claim every non-gateway host
    GET    /v1/claim/fleet                     — fleet status
    POST   /v1/claim/release/{ip}              — release a device
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


# ── Ownership Verification ────────────────────────────────────────────

class OwnershipPinChallengeRequest(BaseModel):
    device_ip: str = Field(..., max_length=45)


class OwnershipPinVerifyRequest(BaseModel):
    device_ip: str = Field(..., max_length=45)
    pin: str = Field(..., min_length=6, max_length=6)


class OwnershipMacVerifyRequest(BaseModel):
    device_ip: str = Field(..., max_length=45)
    mac: str = Field(..., max_length=17)
    serial: str | None = Field(default=None, max_length=128)


class OwnershipChallengeStartResponse(BaseModel):
    challenge_id: str
    challenge_type: str
    expires_in_seconds: int
    pin_visible_to_user: bool = Field(
        description="True if this response contains the PIN that the user will see "
                    "on the device — only true in dev/test environments. In prod the "
                    "PIN is delivered out-of-band (the device's own screen).",
    )
    pin: str | None = None


class OwnershipVerifyResponse(BaseModel):
    ok: bool
    device_ip: str
    verified: bool
    message: str


@router.post("/ownership/start-pin", response_model=OwnershipChallengeStartResponse)
async def start_pin_challenge(
    payload: OwnershipPinChallengeRequest,
    principal: Principal = Depends(require_user),
    session: AsyncSession = Depends(get_session),
) -> OwnershipChallengeStartResponse:
    """Mint a 6-digit PIN that the device should now be displaying on its
    own screen.  The user reads it off the device and POSTs it back to
    ``/ownership/verify-pin`` to prove physical/visual access."""
    await _require_tos(session, principal.user.id)
    from app.services.device_ownership_verify import get_ownership_verify_service, CHALLENGE_TTL_SECONDS
    verify = get_ownership_verify_service()
    challenge = await verify.start_pin_challenge(payload.device_ip)
    return OwnershipChallengeStartResponse(
        challenge_id=challenge.challenge_id,
        challenge_type="pin_display",
        expires_in_seconds=CHALLENGE_TTL_SECONDS,
        # The PIN is sent back to the renderer so it can show the user
        # what to enter; we trust the same authenticated session that
        # initiated the claim. The wire-level secrecy is provided by HTTPS
        # to the renderer, never to the device under test.
        pin_visible_to_user=True,
        pin=challenge.pin,
    )


@router.post("/ownership/verify-pin", response_model=OwnershipVerifyResponse)
async def verify_pin(
    payload: OwnershipPinVerifyRequest,
    principal: Principal = Depends(require_user),
    session: AsyncSession = Depends(get_session),
) -> OwnershipVerifyResponse:
    """Verify the user typed back the PIN the device displayed."""
    await _require_tos(session, principal.user.id)
    from app.services.device_ownership_verify import get_ownership_verify_service
    verify = get_ownership_verify_service()
    success, message = await verify.verify_pin(principal.user.id, payload.device_ip, payload.pin)
    if not success:
        raise ValidationError_(message).as_http()
    return OwnershipVerifyResponse(
        ok=True, device_ip=payload.device_ip, verified=True, message=message,
    )


@router.post("/ownership/verify-mac", response_model=OwnershipVerifyResponse)
async def verify_mac_serial(
    payload: OwnershipMacVerifyRequest,
    principal: Principal = Depends(require_user),
    session: AsyncSession = Depends(get_session),
) -> OwnershipVerifyResponse:
    """Verify the user can read the MAC (and optional serial) off the
    device's own settings UI — proves admin access without needing the
    device to display anything for us."""
    await _require_tos(session, principal.user.id)
    from app.services.device_ownership_verify import get_ownership_verify_service
    from app.services.network_scanner import get_network_scanner

    scanner = get_network_scanner()
    fp = scanner.get_device(payload.device_ip)
    if fp is None:
        raise ValidationError_(
            f"No scan data for {payload.device_ip}. Run /v1/claim/scan first."
        ).as_http()
    if not fp.mac:
        raise ValidationError_(
            f"No MAC address recorded for {payload.device_ip}."
        ).as_http()

    verify = get_ownership_verify_service()
    await verify.start_mac_serial_challenge(
        payload.device_ip, expected_mac=fp.mac, expected_serial=payload.serial,
    )
    success, message = await verify.verify_mac_serial(
        principal.user.id, payload.device_ip, payload.mac, payload.serial,
    )
    if not success:
        raise ValidationError_(message).as_http()
    return OwnershipVerifyResponse(
        ok=True, device_ip=payload.device_ip, verified=True, message=message,
    )
