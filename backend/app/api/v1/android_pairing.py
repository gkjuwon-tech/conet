"""
Android Pairing API (V3) — LAN-local Android enrollment endpoints.

    GET    /v1/android/status              — adb availability + stats + friend list
    POST   /v1/android/friends             — set friend-or-foe list for the session
    POST   /v1/android/friends/veto/{ip}   — permanently skip a target this session
    POST   /v1/android/discover            — sweep mDNS for Wireless-debugging offers
    GET    /v1/android/discover/results    — cached sweep results
    POST   /v1/android/enroll              — pair + connect a single Android target
    POST   /v1/android/enroll-many         — same, batched over discovered offers

The pairing PIN is read off the user's phone (Developer Options → Wireless
debugging → Pair device with pairing code). The frontend POSTs it here; we
feed it to ``adb pair`` via stdin and never log the PIN itself (only its
length).  All endpoints require ToS acceptance.
"""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends, status
from pydantic import BaseModel, Field
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.dependencies import Principal, require_user
from app.db.session import get_session
from app.exceptions import ValidationError_
from app.services.android_pairing import get_android_pairing_service
from app.services.tos_service import get_tos_service

router = APIRouter(prefix="/android", tags=["android-pairing"])


async def _require_tos(session: AsyncSession, user_id: str) -> None:
    tos = get_tos_service()
    check = await tos.check(session, user_id=user_id)
    if not check.get("accepted"):
        raise ValidationError_(
            "ToS not accepted — POST /v1/claim/tos/accept first"
        ).as_http()


# ── status ────────────────────────────────────────────────────────────────

@router.get("/status")
async def status_(
    principal: Principal = Depends(require_user),
) -> dict[str, Any]:
    """Snapshot of the Android pairing service.

    Useful as a health probe in CI and as a "is adb installed?" answer
    for the desktop app.
    """
    return get_android_pairing_service().snapshot()


# ── friend / foe list ─────────────────────────────────────────────────────

class FriendsRequest(BaseModel):
    our_ip: str = Field(default="", max_length=45)
    our_mac: str = Field(default="", max_length=17)
    gateway_ip: str = Field(default="", max_length=45)
    gateway_mac: str = Field(default="", max_length=17)
    friends_ip: list[str] = Field(default_factory=list, max_length=64)
    friends_mac: list[str] = Field(default_factory=list, max_length=64)


@router.post("/friends")
async def set_friends(
    payload: FriendsRequest,
    principal: Principal = Depends(require_user),
    session: AsyncSession = Depends(get_session),
) -> dict[str, Any]:
    """Set the friend-or-foe filter for this session.

    Anything in ``friends_ip`` / ``friends_mac`` (plus the host's own
    ip/mac and the gateway) will be silently skipped by the enroll
    endpoints — this is what was missing on iPhone, where the legacy
    service happily tried to claim the user's own machine.
    """
    await _require_tos(session, principal.user.id)
    svc = get_android_pairing_service()
    return svc.configure_friends(
        our_ip=payload.our_ip,
        our_mac=payload.our_mac,
        gateway_ip=payload.gateway_ip,
        gateway_mac=payload.gateway_mac,
        friends_ip=payload.friends_ip,
        friends_mac=payload.friends_mac,
    )


@router.post("/friends/veto/{target_ip}")
async def veto_target(
    target_ip: str,
    principal: Principal = Depends(require_user),
) -> dict[str, Any]:
    """Veto a target for the rest of the session (idempotent)."""
    return get_android_pairing_service().veto(target_ip)


# ── discovery ─────────────────────────────────────────────────────────────

class DiscoverRequest(BaseModel):
    force: bool = Field(default=False)
    listen_seconds: float = Field(default=4.5, ge=1.0, le=20.0)


@router.post("/discover")
async def discover(
    payload: DiscoverRequest = DiscoverRequest(),
    principal: Principal = Depends(require_user),
    session: AsyncSession = Depends(get_session),
) -> dict[str, Any]:
    """Run an mDNS sweep for ``_adb-tls-pairing._tcp.local.`` advertisements.

    Returns every (ip, port, service) tuple the listener captured during
    the window. The result is also cached for ~30s — subsequent calls
    without ``force=True`` return the cached list.
    """
    await _require_tos(session, principal.user.id)
    svc = get_android_pairing_service()
    if payload.force:
        offers = await svc.sweep_offers(force=True)
    else:
        offers = await svc.sweep_offers()
    return {
        "offers": [o.to_dict() for o in offers],
        "count": len(offers),
    }


@router.get("/discover/results")
async def discover_results(
    principal: Principal = Depends(require_user),
) -> dict[str, Any]:
    svc = get_android_pairing_service()
    return {
        "offers": [o.to_dict() for o in svc.offers],
        "count": len(svc.offers),
    }


# ── enrollment ────────────────────────────────────────────────────────────

class EnrollRequest(BaseModel):
    target_ip: str = Field(..., max_length=45)
    target_mac: str = Field(default="", max_length=17)
    pin: str | None = Field(default=None, min_length=4, max_length=8)
    port: int | None = Field(default=None, ge=1024, le=65535)
    prefer: str = Field(
        default="auto",
        pattern="^(auto|mdns_pair|legacy_connect)$",
    )


@router.post("/enroll", status_code=status.HTTP_201_CREATED)
async def enroll(
    payload: EnrollRequest,
    principal: Principal = Depends(require_user),
    session: AsyncSession = Depends(get_session),
) -> dict[str, Any]:
    """Pair (if PIN supplied) + connect a single Android device.

    Strategy (handled inside the service):

      1. Skip if target matches friend-or-foe filter.
      2. If PIN supplied → ``adb pair host:port <pin>``  + ``adb connect``.
      3. Else → ``adb connect host:{5555/5554/...}``.
      4. Last resort → mDNS sweep + connect to any advertised port.

    The PIN is never logged — only its length appears in structured logs.
    """
    await _require_tos(session, principal.user.id)
    svc = get_android_pairing_service()
    outcome = await svc.enroll(
        ip=payload.target_ip,
        mac=payload.target_mac,
        pin=payload.pin,
        port=payload.port,
        prefer=payload.prefer,
    )
    return outcome.to_dict()


class EnrollManyRequest(BaseModel):
    pin: str | None = Field(default=None, min_length=4, max_length=8)
    targets: list[str] | None = Field(default=None, max_length=128)
    prefer: str = Field(
        default="auto",
        pattern="^(auto|mdns_pair|legacy_connect)$",
    )


@router.post("/enroll-many", status_code=status.HTTP_201_CREATED)
async def enroll_many(
    payload: EnrollManyRequest = EnrollManyRequest(),
    principal: Principal = Depends(require_user),
    session: AsyncSession = Depends(get_session),
) -> dict[str, Any]:
    """Batch-enroll every IP in ``targets`` (or every cached mDNS offer).

    If ``targets`` is None we use the latest mDNS sweep result. The friend-
    or-foe filter is applied per-target before any ADB call goes out.
    """
    await _require_tos(session, principal.user.id)
    svc = get_android_pairing_service()
    if payload.targets is None:
        offers = await svc.sweep_offers()
        targets = sorted({o.ip for o in offers})
    else:
        targets = list(dict.fromkeys(t.strip() for t in payload.targets if t.strip()))

    results = []
    for ip in targets:
        outcome = await svc.enroll(
            ip=ip,
            pin=payload.pin,
            prefer=payload.prefer,
        )
        results.append(outcome.to_dict())

    return {
        "attempted": len(results),
        "succeeded": sum(1 for r in results if r.get("ok")),
        "failed": sum(1 for r in results if not r.get("ok") and r.get("method") != "skip_friend"),
        "skipped_friend": sum(1 for r in results if r.get("method") == "skip_friend"),
        "results": results,
    }
