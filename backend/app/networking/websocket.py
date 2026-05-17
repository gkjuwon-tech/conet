from __future__ import annotations

import json
from collections.abc import Callable
from datetime import datetime, timezone
from typing import Any

from fastapi import WebSocket, WebSocketDisconnect
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.jwt import decode_token
from app.crypto.attestation import (
    Challenge,
    issue_pow_challenge,
    verify_pow_response,
    verify_signed_attestation,
)
from app.db.models import Device
from app.db.models.device import DeviceStatus
from app.db.session import SessionLocal
from app.exceptions import AuthError
from app.logging_setup import get_logger
from app.networking.protocol import (
    AckFrame,
    AgentMessageType,
    ChallengeFrame,
    ChallengeResponseFrame,
    HeartbeatFrame,
    RequestWorkFrame,
    WorkDispatchFrame,
    WorkResultFrame,
)
from app.schemas.device import DeviceHeartbeat
from app.services.dispatcher import JobDispatcher
from app.services.heartbeat import HeartbeatProcessor
from app.utils.time import utcnow


log = get_logger("ws")


class AgentSession:
    def __init__(self, ws: WebSocket, device: Device) -> None:
        self.ws = ws
        self.device = device
        self.challenge: Challenge | None = None
        self.attested = False
        self.dispatcher = JobDispatcher()
        self.heartbeats = HeartbeatProcessor()

    async def send(self, frame: Any) -> None:
        if isinstance(frame, dict):
            await self.ws.send_text(json.dumps(frame))
        else:
            await self.ws.send_text(frame.model_dump_json())

    async def run(self) -> None:
        try:
            await self._issue_challenge()
            async for raw in _iter_text(self.ws):
                try:
                    msg = json.loads(raw)
                except json.JSONDecodeError:
                    await self.send(_error("bad_json", "invalid JSON frame"))
                    continue
                handler = ROUTES.get(msg.get("type", ""))
                if handler is None:
                    await self.send(_error("unknown_type", f"no handler for {msg.get('type')}"))
                    continue
                try:
                    await handler(self, msg)
                except AuthError as e:
                    await self.send(_error("auth", str(e)))
                    break
                except Exception as e:
                    log.exception("ws.handler_error", error=str(e))
                    await self.send(_error("internal", "handler failure"))
        except WebSocketDisconnect:
            log.info("ws.disconnect", device_id=self.device.id)
        finally:
            await self._on_close()

    async def _issue_challenge(self) -> None:
        ch = issue_pow_challenge(difficulty=18 if self.device.public_key is None else 14)
        self.challenge = ch
        method = "rsa-pkcs1v15" if self.device.public_key else "pow"
        await self.send(
            ChallengeFrame(
                challenge_id=ch.challenge_id,
                nonce=ch.nonce,
                difficulty=ch.difficulty,
                method=method,  # type: ignore[arg-type]
            )
        )

    async def _on_close(self) -> None:
        async with SessionLocal() as session:
            d = await session.get(Device, self.device.id)
            if d is None:
                return
            if d.status == DeviceStatus.idle:
                d.status = DeviceStatus.offline
                await session.commit()


async def _on_challenge_response(self: AgentSession, msg: dict[str, Any]) -> None:
    if self.challenge is None:
        await self.send(_error("no_challenge", "challenge not issued"))
        return
    frame = ChallengeResponseFrame.model_validate(msg)
    ok = False
    if frame.signature_hex and self.device.public_key:
        ok = verify_signed_attestation(
            self.device.public_key, self.challenge.nonce, frame.signature_hex
        )
    elif frame.candidate is not None:
        ok = verify_pow_response(self.challenge, frame.candidate)
    if not ok:
        await self.send(_error("attestation_failed", "challenge response invalid"))
        raise AuthError("attestation failed")
    self.attested = True
    async with SessionLocal() as session:
        d = await session.get(Device, self.device.id)
        if d is not None:
            d.attestation_verified_at = utcnow()
            if d.status == DeviceStatus.pending_attestation:
                d.status = DeviceStatus.idle
            await session.commit()
    await self.send(AckFrame(ref="attested"))


async def _on_heartbeat(self: AgentSession, msg: dict[str, Any]) -> None:
    frame = HeartbeatFrame.model_validate(msg)
    hb = DeviceHeartbeat(
        cpu_usage_pct=frame.cpu_usage_pct,
        gpu_usage_pct=frame.gpu_usage_pct,
        ram_usage_pct=frame.ram_usage_pct,
        temperature_c=frame.temperature_c,
        rssi_dbm=frame.rssi_dbm,
        download_mbps=frame.download_mbps,
        upload_mbps=frame.upload_mbps,
        extras=frame.extras,
    )
    async with SessionLocal() as session:
        d = await session.get(Device, self.device.id)
        if d is None:
            return
        await self.heartbeats.ingest(session, d, hb)
    await self.send(AckFrame(ref="hb"))


async def _on_request_work(self: AgentSession, msg: dict[str, Any]) -> None:
    if not self.attested:
        await self.send(_error("not_attested", "attest first"))
        return
    frame = RequestWorkFrame.model_validate(msg)
    async with SessionLocal() as session:
        d = await session.get(Device, self.device.id)
        if d is None:
            return
        units = await self.dispatcher.claim_next_unit(session, device=d, max_units=frame.max_units)
        await session.commit()

    for u in units:
        await self.send(
            WorkDispatchFrame(
                workunit_id=u.workunit_id,
                workunit_handle=u.handle,
                job_id=u.payload.get("job_id", ""),
                job_kind=u.payload.get("kind", ""),
                payload=u.payload,
                expected_runtime_seconds=u.expected_runtime_seconds,
                deadline_iso=datetime.now(timezone.utc).isoformat(),
            )
        )

    if not units:
        await self.send(AckFrame(ref="no_work"))


async def _on_work_result(self: AgentSession, msg: dict[str, Any]) -> None:
    frame = WorkResultFrame.model_validate(msg)
    async with SessionLocal() as session:
        d = await session.get(Device, self.device.id)
        if d is None:
            return
        await self.dispatcher.submit_result(
            session,
            device=d,
            workunit_id=frame.workunit_id,
            runtime_ms=frame.runtime_ms,
            result=frame.result,
            result_hash=frame.result_hash,
            proof=frame.proof,
            error_code=frame.error_code,
            error_message=frame.error_message,
        )
        await session.commit()
    await self.send(AckFrame(ref=frame.workunit_id))


ROUTES: dict[str, Callable[[AgentSession, dict[str, Any]], Any]] = {
    AgentMessageType.challenge_response.value: _on_challenge_response,
    AgentMessageType.heartbeat.value: _on_heartbeat,
    AgentMessageType.request_work.value: _on_request_work,
    AgentMessageType.work_result.value: _on_work_result,
}


async def authenticate_websocket(
    websocket: WebSocket, session: AsyncSession
) -> Device:
    token = websocket.query_params.get("token") or websocket.headers.get("authorization", "").removeprefix("Bearer ").strip()
    if not token:
        await websocket.close(code=1008)
        raise AuthError("missing token")
    try:
        claims = decode_token(token)
    except AuthError:
        await websocket.close(code=1008)
        raise

    if claims.kind != "device" or not claims.device_id:
        await websocket.close(code=1008)
        raise AuthError("not a device token")

    device = await session.get(Device, claims.device_id)
    if device is None:
        await websocket.close(code=1008)
        raise AuthError("unknown device")

    return device


async def _iter_text(ws: WebSocket):
    while True:
        text = await ws.receive_text()
        yield text


def _error(code: str, message: str) -> dict[str, Any]:
    return {"type": "error", "code": code, "message": message}
