"""
Claim API (V3) — network device acquisition endpoints.

    --- ToS ---
    GET    /v1/claim/tos              — consent content for frontend
    POST   /v1/claim/tos/accept       — record acceptance
    GET    /v1/claim/tos/status        — check acceptance state

    --- Network scan ---
    POST   /v1/claim/scan             — trigger ARP / SSDP / port scan
    GET    /v1/claim/scan/results     — cached results

    --- Ownership Verification ---
    POST   /v1/claim/ownership/start-pin       — start PIN challenge
    POST   /v1/claim/ownership/verify-pin      — verify PIN
    POST   /v1/claim/ownership/verify-mac      — verify MAC/serial

    --- Claim execution ---
    POST   /v1/claim/execute          — claim a single device
    POST   /v1/claim/execute-all      — claim every non-gateway host
    GET    /v1/claim/fleet            — fleet status
    POST   /v1/claim/release/{ip}     — release a device
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
    """Host-side LAN identity — the CLI/desktop gathers this from its own
    adapter and ships it with the claim request so the backend can bring up
    the L2 primitives (ARP impersonator etc.) that need real-machine info."""
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


# ── TV Launcher (LG webOS SSAP) ────────────────────────────────────────

class TvLaunchRequest(BaseModel):
    tv_ip: str = Field(..., max_length=45)
    tv_mac: str = Field(..., max_length=17)
    portal_url: str = Field(..., max_length=200)
    restore_app_id: str | None = Field(default=None, max_length=80)
    settle_seconds: float = Field(default=4.0, ge=0.5, le=30.0)


@router.post("/tv/launch")
async def tv_launch(
    payload: TvLaunchRequest,
    principal: Principal = Depends(require_user),
    session: AsyncSession = Depends(get_session),
) -> dict[str, Any]:
    """Launch our portal in the LG TV's browser, then restore live TV."""
    await _require_tos(session, principal.user.id)
    from app.services.tv_launcher import launch_portal_background
    r = await launch_portal_background(
        tv_ip=payload.tv_ip,
        tv_mac=payload.tv_mac,
        portal_url=payload.portal_url,
        restore_app_id=payload.restore_app_id,
        settle_seconds=payload.settle_seconds,
    )
    return {
        "ok": r.ok,
        "tv_ip": r.tv_ip,
        "portal_url": r.portal_url,
        "client_key_cached": bool(r.client_key),
        "foreground_was": r.foreground_was,
        "restored_to": r.restored_to,
        "error": r.error,
    }


# ── Portal stats (also served on host:80 directly) ─────────────────────

@router.get("/portal/stats")
async def portal_stats(
    principal: Principal = Depends(require_user),
) -> dict[str, Any]:
    from app.services.portal_server import get_portal_server
    srv = get_portal_server()
    return {
        "running": srv._server is not None,
        "our_ip": srv.our_ip,
        "port": srv.bind_port,
        "claims": srv.ledger.claims,
        "submits": srv.ledger.submits,
        "by_device": srv.ledger.by_device,
    }


# ── AdminGateway — central one-click approval ──────────────────────────

class GatewayApproveRequest(BaseModel):
    device_ips: list[str] | None = Field(default=None, description="None = all")
    portal_base_url: str | None = Field(default=None, max_length=200)


class GatewayCloudLoginRequest(BaseModel):
    vendor: str = Field(..., max_length=40)
    info: dict[str, Any] = Field(default_factory=dict)


@router.post("/gateway/refresh")
async def gateway_refresh(
    principal: Principal = Depends(require_user),
    session: AsyncSession = Depends(get_session),
) -> dict[str, Any]:
    """Re-run a scan and rebuild the approval queue from the result."""
    await _require_tos(session, principal.user.id)
    from app.services.admin_gateway import get_admin_gateway
    from app.services.network_scanner import get_network_scanner
    scanner = get_network_scanner()
    fps = scanner.cached_results or await scanner.scan(force=False)
    return get_admin_gateway().rebuild_queue(fps)


@router.get("/gateway/queue")
async def gateway_queue(
    principal: Principal = Depends(require_user),
) -> dict[str, Any]:
    from app.services.admin_gateway import get_admin_gateway
    return get_admin_gateway().snapshot()


@router.post("/gateway/cloud-login")
async def gateway_cloud_login(
    payload: GatewayCloudLoginRequest,
    principal: Principal = Depends(require_user),
) -> dict[str, Any]:
    """Record that the user has signed into ``vendor`` cloud on this
    laptop.  Connectors that need cloud auth (Cast SDK, ThinQ, etc.)
    check this before attempting cloud calls."""
    from app.services.admin_gateway import get_admin_gateway
    gw = get_admin_gateway()
    gw.record_cloud_login(payload.vendor, payload.info)
    return {"ok": True, "cloud_logins": gw.cloud_logins()}


@router.post("/gateway/approve")
async def gateway_approve(
    payload: GatewayApproveRequest = GatewayApproveRequest(),
    principal: Principal = Depends(require_user),
    session: AsyncSession = Depends(get_session),
) -> dict[str, Any]:
    """One-click approval.  If ``device_ips`` is None → approve every
    eligible queue entry concurrently."""
    await _require_tos(session, principal.user.id)
    from app.services.admin_gateway import get_admin_gateway
    from app.services.network_scanner import get_network_scanner
    gw = get_admin_gateway()
    if payload.portal_base_url:
        gw.set_portal_base_url(payload.portal_base_url)
    scanner = get_network_scanner()
    fp_lookup = scanner.get_device
    if payload.device_ips:
        results: dict[str, Any] = {}
        for ip in payload.device_ips:
            results[ip] = await gw.approve_one(ip, fp_lookup=fp_lookup)
        return {"attempted": len(results), "results": results,
                "snapshot": gw.snapshot()}
    return await gw.approve_all(fp_lookup=fp_lookup)


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
