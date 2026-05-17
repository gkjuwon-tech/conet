from __future__ import annotations

from fastapi import APIRouter, Depends, Request, status
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.dependencies import Principal, require_user
from app.db.session import get_session
from app.schemas.lan_claim import (
    LanClaimDispute,
    LanClaimRequest,
    LanClaimRequestPublic,
    LanClaimVerify,
)
from app.services.lan_claim import LanClaimService

router = APIRouter(prefix="/lan-claims", tags=["lan-claims"])


def _serialize(claim, otp: str | None = None) -> LanClaimRequestPublic:
    base = LanClaimRequestPublic.model_validate(claim)
    if otp is not None:
        base = base.model_copy(update={"delivered_otp_dev": otp})
    return base


@router.post(
    "",
    response_model=LanClaimRequestPublic,
    status_code=status.HTTP_201_CREATED,
)
async def request_claim(
    payload: LanClaimRequest,
    request: Request,
    principal: Principal = Depends(require_user),
    session: AsyncSession = Depends(get_session),
) -> LanClaimRequestPublic:
    service = LanClaimService()
    outcome = await service.request_claim(
        session,
        user=principal.user,
        lan_fingerprint=payload.lan_fingerprint,
        gateway_ip=payload.gateway_ip,
        gateway_mac=payload.gateway_mac,
        advertised_subnet=payload.advertised_subnet,
        label=payload.label,
        ip=str(request.client.host) if request.client else None,
        user_agent=request.headers.get("user-agent"),
    )
    return _serialize(outcome.claim, outcome.otp)


@router.post("/verify", response_model=LanClaimRequestPublic)
async def verify_claim(
    payload: LanClaimVerify,
    principal: Principal = Depends(require_user),
    session: AsyncSession = Depends(get_session),
) -> LanClaimRequestPublic:
    service = LanClaimService()
    claim = await service.verify_claim(
        session,
        user=principal.user,
        lan_fingerprint=payload.lan_fingerprint,
        otp=payload.otp,
    )
    return _serialize(claim)


@router.get("", response_model=list[LanClaimRequestPublic])
async def list_claims(
    principal: Principal = Depends(require_user),
    session: AsyncSession = Depends(get_session),
) -> list[LanClaimRequestPublic]:
    service = LanClaimService()
    rows = await service.list_for_user(session, principal.user.id)
    return [_serialize(c) for c in rows]


@router.delete("/{claim_id}", response_model=LanClaimRequestPublic)
async def revoke_claim(
    claim_id: str,
    principal: Principal = Depends(require_user),
    session: AsyncSession = Depends(get_session),
) -> LanClaimRequestPublic:
    service = LanClaimService()
    claim = await service.revoke(session, user=principal.user, claim_id=claim_id)
    return _serialize(claim)


@router.post("/dispute")
async def dispute_claim(
    payload: LanClaimDispute,
    principal: Principal = Depends(require_user),
    session: AsyncSession = Depends(get_session),
) -> dict:
    service = LanClaimService()
    return await service.dispute(
        session,
        disputing_user=principal.user,
        lan_fingerprint=payload.lan_fingerprint,
        reason=payload.reason,
    )
