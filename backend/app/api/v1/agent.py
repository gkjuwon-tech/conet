from __future__ import annotations

from fastapi import APIRouter, Depends, WebSocket, WebSocketException, status
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.dependencies import Principal, require_device
from app.crypto.attestation import (
    issue_pow_challenge,
    verify_pow_response,
    verify_signed_attestation,
)
from app.db.models.device import DeviceStatus
from app.db.session import get_session, transactional
from app.exceptions import AuthError
from app.networking.websocket import AgentSession, authenticate_websocket
from app.schemas.device import DeviceHeartbeat
from app.services.dispatcher import JobDispatcher
from app.services.heartbeat import HeartbeatProcessor
from app.utils.time import utcnow


router = APIRouter(prefix="/agent", tags=["agent"])


@router.post("/attest/challenge")
async def request_challenge(principal: Principal = Depends(require_device)) -> dict:
    # Difficulty tuned to the device class:
    #   18 — modern phone / desktop / NAS (~1s on V8)
    #   14 — tablet / TV / console with snappier WebKit (~1s on Chromium TV)
    #   10 — embedded class IoT / older TV browsers (Tizen 4 / webOS 3 etc.)
    # We pick by h100_equivalent because that's already a rough perf proxy
    # and avoids a giant device_class switch. Devices with a public key
    # (RSA-attested) bypass the PoW path entirely.
    if principal.device.public_key:
        difficulty = 14
    else:
        h = principal.device.h100_equivalent or 0
        if h >= 0.005:
            difficulty = 18
        elif h >= 0.001:
            difficulty = 14
        else:
            difficulty = 10
    challenge = issue_pow_challenge(difficulty=difficulty)
    method = "rsa-pkcs1v15" if principal.device.public_key else "pow"
    return {
        "challenge_id": challenge.challenge_id,
        "nonce": challenge.nonce,
        "difficulty": challenge.difficulty,
        "method": method,
    }


@router.post("/attest/verify")
async def verify_challenge(
    payload: dict,
    principal: Principal = Depends(require_device),
    session: AsyncSession = Depends(get_session),
) -> dict:
    nonce = payload.get("nonce")
    if not nonce:
        raise AuthError("missing nonce").as_http()

    ok = False
    if payload.get("signature_hex") and principal.device.public_key:
        ok = verify_signed_attestation(
            principal.device.public_key, nonce, payload["signature_hex"]
        )
    elif payload.get("candidate"):
        from app.crypto.attestation import Challenge

        ch = Challenge(
            challenge_id="-",
            nonce=nonce,
            issued_at_ms=0,
            difficulty=int(payload.get("difficulty", 18)),
        )
        ok = verify_pow_response(ch, payload["candidate"])

    if not ok:
        raise AuthError("attestation invalid").as_http()

    async with transactional(session):
        d = await session.get(principal.device.__class__, principal.device.id, with_for_update=True)
        if d is None:
            raise AuthError("device gone").as_http()
        d.attestation_verified_at = utcnow()
        if d.status == DeviceStatus.pending_attestation:
            d.status = DeviceStatus.idle

    return {"ok": True, "verified_at": utcnow().isoformat()}


@router.post("/heartbeat")
async def heartbeat(
    payload: DeviceHeartbeat,
    principal: Principal = Depends(require_device),
    session: AsyncSession = Depends(get_session),
) -> dict:
    processor = HeartbeatProcessor()
    await processor.ingest(session, principal.device, payload)
    return {"ok": True, "device_id": principal.device.id}


@router.post("/work/claim")
async def claim_work(
    principal: Principal = Depends(require_device),
    session: AsyncSession = Depends(get_session),
    max_units: int = 1,
) -> list[dict]:
    dispatcher = JobDispatcher()
    units = await dispatcher.claim_next_unit(
        session, device=principal.device, max_units=max_units
    )
    await session.commit()
    return [
        {
            "workunit_id": u.workunit_id,
            "handle": u.handle,
            "payload": u.payload,
            "expected_runtime_seconds": u.expected_runtime_seconds,
        }
        for u in units
    ]


@router.post("/work/submit")
async def submit_work(
    payload: dict,
    principal: Principal = Depends(require_device),
    session: AsyncSession = Depends(get_session),
) -> dict:
    dispatcher = JobDispatcher()
    outcome = await dispatcher.submit_result(
        session,
        device=principal.device,
        workunit_id=payload["workunit_id"],
        runtime_ms=int(payload.get("runtime_ms", 0)),
        result=payload.get("result", {}),
        result_hash=str(payload.get("result_hash", "")),
        proof=payload.get("proof"),
        error_code=payload.get("error_code"),
        error_message=payload.get("error_message"),
    )
    await session.commit()
    return {
        "workunit_id": outcome.workunit_id,
        "consensus_achieved": outcome.achieved,
        "consensus_score": outcome.score,
        "winning_hash": outcome.winning_hash,
    }


@router.websocket("/ws")
async def agent_ws(
    websocket: WebSocket,
    session: AsyncSession = Depends(get_session),
) -> None:
    try:
        device = await authenticate_websocket(websocket, session)
    except AuthError:
        return
    await websocket.accept(subprotocol="electromesh.v1")
    try:
        agent = AgentSession(websocket, device)
        await agent.run()
    except WebSocketException:
        await websocket.close(code=status.WS_1011_INTERNAL_ERROR)
