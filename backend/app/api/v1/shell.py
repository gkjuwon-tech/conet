"""WebSocket proxy + REST control plane for interactive shell sessions."""
from __future__ import annotations

import asyncio
from typing import Any

from fastapi import (
    APIRouter,
    Body,
    Depends,
    WebSocket,
    WebSocketDisconnect,
    status,
)
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.dependencies import Principal, require_enterprise
from app.db.models.job import Job, JobKind, JobStatus
from app.db.models.shell_session import ShellSession, ShellSessionStatus
from app.db.session import SessionLocal, get_session
from app.exceptions import ConflictError, NotFoundError, PermissionError_
from app.logging_setup import get_logger
from app.services.shell_proxy import ShellOrchestrator, ShellSpec
from app.services.stripe_billing import StripeBilling


router = APIRouter(prefix="/shell", tags=["shell"])
log = get_logger("shell")


@router.post("", status_code=status.HTTP_201_CREATED)
async def create_shell(
    payload: dict = Body(...),
    principal: Principal = Depends(require_enterprise),
    session: AsyncSession = Depends(get_session),
) -> dict:
    enterprise = principal.enterprise
    if not enterprise:
        raise PermissionError_("enterprise required").as_http()

    job_id = payload.get("job_id")
    cluster_id = payload.get("cluster_id")
    if not job_id or not cluster_id:
        raise ConflictError("job_id and cluster_id required").as_http()

    job = await session.get(Job, job_id)
    if job is None:
        raise NotFoundError("job not found").as_http()
    if job.enterprise_id != enterprise.id:
        raise PermissionError_("not your job").as_http()
    if job.kind != JobKind.compute_shell:
        raise ConflictError("job kind must be compute.shell").as_http()
    if job.status not in (JobStatus.running, JobStatus.queued, JobStatus.leasing):
        raise ConflictError(f"job not active: {job.status}").as_http()

    spec = ShellSpec(
        image=payload.get("image"),
        workdir=payload.get("workdir") or None,
        env=dict(payload.get("env") or {}),
        cmd=payload.get("cmd") or None,
        cpu_cap_pct=float(payload.get("cpu_cap_pct", 80.0)),
        memory_mb_cap=int(payload.get("memory_mb_cap", 2048)),
        disk_mb_cap=int(payload.get("disk_mb_cap", 4096)),
        network_egress_mbps_cap=float(payload.get("network_egress_mbps_cap", 10.0)),
        ttl_seconds=int(payload.get("ttl_seconds", 3600)),
    )

    orch = ShellOrchestrator()
    shell = await orch.create(
        session, enterprise=enterprise, job=job, spec=spec, cluster_id=cluster_id
    )

    return {
        "id": shell.id,
        "status": shell.status.value,
        "enterprise_token": shell.enterprise_token,
        "device_token": shell.device_token,
        "device_id": shell.device_id,
        "rate_usd_per_hour": shell.rate_usd_per_hour,
        "expires_at": shell.expires_at.isoformat(),
        "image": shell.image,
        "workdir": shell.workdir,
        "cmd": shell.cmd,
        "ws_enterprise": f"/v1/shell/ws/enterprise?token={shell.enterprise_token}",
        "ws_device": f"/v1/shell/ws/device?token={shell.device_token}",
    }


@router.get("/{shell_id}")
async def get_shell(
    shell_id: str,
    principal: Principal = Depends(require_enterprise),
    session: AsyncSession = Depends(get_session),
) -> dict:
    shell = await session.get(ShellSession, shell_id)
    if shell is None or shell.enterprise_id != principal.enterprise.id:
        raise NotFoundError("shell not found").as_http()
    return _serialize_shell(shell)


@router.get("")
async def list_shells(
    principal: Principal = Depends(require_enterprise),
    session: AsyncSession = Depends(get_session),
    limit: int = 50,
) -> list[dict]:
    rows = list(
        (
            await session.execute(
                select(ShellSession)
                .where(ShellSession.enterprise_id == principal.enterprise.id)
                .order_by(ShellSession.created_at_ts.desc())
                .limit(limit)
            )
        ).scalars()
    )
    return [_serialize_shell(s) for s in rows]


@router.delete("/{shell_id}")
async def close_shell(
    shell_id: str,
    principal: Principal = Depends(require_enterprise),
    session: AsyncSession = Depends(get_session),
) -> dict:
    shell = await session.get(ShellSession, shell_id)
    if shell is None or shell.enterprise_id != principal.enterprise.id:
        raise NotFoundError("shell not found").as_http()
    orch = ShellOrchestrator()
    closed = await orch.close(session, shell_id=shell_id, reason="closed by enterprise")
    billing = StripeBilling()
    await billing.settle_job(
        session,
        enterprise_id=closed.enterprise_id,
        job_id=closed.job_id,
        spent_cents=closed.metered_cents,
    )
    return _serialize_shell(closed)


def _serialize_shell(s: ShellSession) -> dict:
    return {
        "id": s.id,
        "enterprise_id": s.enterprise_id,
        "job_id": s.job_id,
        "device_id": s.device_id,
        "status": s.status.value,
        "image": s.image,
        "workdir": s.workdir,
        "cmd": s.cmd,
        "cpu_cap_pct": s.cpu_cap_pct,
        "memory_mb_cap": s.memory_mb_cap,
        "disk_mb_cap": s.disk_mb_cap,
        "rate_usd_per_hour": s.rate_usd_per_hour,
        "runtime_seconds": s.runtime_seconds,
        "metered_cents": s.metered_cents,
        "bytes_in": s.bytes_in,
        "bytes_out": s.bytes_out,
        "created_at": s.created_at_ts.isoformat() if s.created_at_ts else None,
        "activated_at": s.activated_at.isoformat() if s.activated_at else None,
        "closed_at": s.closed_at.isoformat() if s.closed_at else None,
        "expires_at": s.expires_at.isoformat() if s.expires_at else None,
    }


# ---------------------------------------------------------------------------
# WebSocket proxy
# ---------------------------------------------------------------------------
#
# In-memory session map: shell_id -> { "device": ws_device, "enterprise": ws_ent }.
# On either side connecting we register; when both are present, we forward
# messages bidirectionally. Disconnect on either side closes the other.

_SESSION_LOCKS: dict[str, asyncio.Lock] = {}
_SESSION_PEERS: dict[str, dict[str, WebSocket]] = {}


def _peer_lock(shell_id: str) -> asyncio.Lock:
    lock = _SESSION_LOCKS.get(shell_id)
    if lock is None:
        lock = asyncio.Lock()
        _SESSION_LOCKS[shell_id] = lock
    return lock


async def _forward_loop(
    src: WebSocket,
    src_label: str,
    shell_id: str,
    on_bytes,  # type: ignore[no-untyped-def]
) -> None:
    """Read from `src`, push to the matching peer if connected."""
    try:
        while True:
            message = await src.receive()
            if message["type"] == "websocket.disconnect":
                break
            peers = _SESSION_PEERS.get(shell_id, {})
            other_label = "enterprise" if src_label == "device" else "device"
            other = peers.get(other_label)

            if "text" in message and message["text"] is not None:
                payload = message["text"]
                size = len(payload.encode("utf-8"))
                await on_bytes(size, src_label)
                if other is not None:
                    try:
                        await other.send_text(payload)
                    except Exception:
                        log.warning("shell.forward_text_failed", shell_id=shell_id)
            elif "bytes" in message and message["bytes"] is not None:
                payload = message["bytes"]
                await on_bytes(len(payload), src_label)
                if other is not None:
                    try:
                        await other.send_bytes(payload)
                    except Exception:
                        log.warning("shell.forward_bytes_failed", shell_id=shell_id)
    except WebSocketDisconnect:
        pass
    except Exception as e:
        log.exception("shell.forward_error", shell_id=shell_id, error=str(e))


@router.websocket("/ws/device")
async def device_ws(websocket: WebSocket) -> None:
    token = websocket.query_params.get("token", "")
    if not token:
        await websocket.close(code=1008)
        return
    async with SessionLocal() as session:
        orch = ShellOrchestrator()
        try:
            shell = await orch.lookup_by_device_token(session, token=token)
        except NotFoundError:
            await websocket.close(code=1008)
            return
        await websocket.accept(subprotocol="electromesh.shell.v1")
        await orch.mark_device_attached(session, shell_id=shell.id)

    shell_id = shell.id
    async with _peer_lock(shell_id):
        peers = _SESSION_PEERS.setdefault(shell_id, {})
        if "device" in peers:
            try:
                await peers["device"].close(code=1001)
            except Exception:
                pass
        peers["device"] = websocket

    # Greet the device with the spawn parameters.
    await websocket.send_json(
        {
            "type": "spawn",
            "shell_id": shell_id,
            "image": shell.image,
            "workdir": shell.workdir,
            "cmd": shell.cmd,
            "env": shell.env,
            "cpu_cap_pct": shell.cpu_cap_pct,
            "memory_mb_cap": shell.memory_mb_cap,
            "disk_mb_cap": shell.disk_mb_cap,
        }
    )

    async def _meter(size: int, src_label: str) -> None:
        async with SessionLocal() as s:
            await ShellOrchestrator().mark_io(
                s,
                shell_id=shell_id,
                bytes_in=size if src_label == "enterprise" else 0,
                bytes_out=size if src_label == "device" else 0,
            )

    try:
        await _forward_loop(websocket, "device", shell_id, _meter)
    finally:
        async with _peer_lock(shell_id):
            peers = _SESSION_PEERS.get(shell_id, {})
            if peers.get("device") is websocket:
                peers.pop("device", None)
            other = peers.get("enterprise")
            if other is not None:
                try:
                    await other.close(code=1001)
                except Exception:
                    pass
        async with SessionLocal() as s:
            try:
                closed = await ShellOrchestrator().close(
                    s, shell_id=shell_id, reason="device disconnected"
                )
                await StripeBilling().settle_job(
                    s,
                    enterprise_id=closed.enterprise_id,
                    job_id=closed.job_id,
                    spent_cents=closed.metered_cents,
                )
            except Exception:
                log.exception("shell.close_failed_on_device_disconnect")


@router.websocket("/ws/enterprise")
async def enterprise_ws(websocket: WebSocket) -> None:
    token = websocket.query_params.get("token", "")
    if not token:
        await websocket.close(code=1008)
        return
    async with SessionLocal() as session:
        orch = ShellOrchestrator()
        try:
            shell = await orch.lookup_by_enterprise_token(session, token=token)
        except NotFoundError:
            await websocket.close(code=1008)
            return
        if shell.status in (
            ShellSessionStatus.closed,
            ShellSessionStatus.revoked,
            ShellSessionStatus.expired,
        ):
            await websocket.close(code=1008)
            return
        await websocket.accept(subprotocol="electromesh.shell.v1")

    shell_id = shell.id
    async with _peer_lock(shell_id):
        peers = _SESSION_PEERS.setdefault(shell_id, {})
        if "enterprise" in peers:
            try:
                await peers["enterprise"].close(code=1001)
            except Exception:
                pass
        peers["enterprise"] = websocket

    await websocket.send_json(
        {
            "type": "session",
            "shell_id": shell_id,
            "status": shell.status.value,
            "image": shell.image,
            "workdir": shell.workdir,
            "cmd": shell.cmd,
            "rate_usd_per_hour": shell.rate_usd_per_hour,
            "expires_at": shell.expires_at.isoformat(),
            "device_attached": "device" in peers,
        }
    )

    async def _meter(size: int, src_label: str) -> None:
        async with SessionLocal() as s:
            await ShellOrchestrator().mark_io(
                s,
                shell_id=shell_id,
                bytes_in=size if src_label == "enterprise" else 0,
                bytes_out=size if src_label == "device" else 0,
            )

    try:
        await _forward_loop(websocket, "enterprise", shell_id, _meter)
    finally:
        async with _peer_lock(shell_id):
            peers = _SESSION_PEERS.get(shell_id, {})
            if peers.get("enterprise") is websocket:
                peers.pop("enterprise", None)
