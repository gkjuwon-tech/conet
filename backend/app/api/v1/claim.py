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
