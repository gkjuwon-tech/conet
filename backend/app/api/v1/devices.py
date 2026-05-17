from __future__ import annotations

from fastapi import APIRouter, Depends, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.dependencies import Principal, require_device, require_user
from app.auth.jwt import mint_token
from app.db.models import Device
from app.db.models.device import DeviceStatus
from app.db.session import get_session, transactional
from app.exceptions import ConflictError, NotFoundError, PermissionError_
from app.schemas.device import (
    DeviceBenchmarkSubmit,
    DeviceDetail,
    DeviceHeartbeat,
    DevicePublic,
    DeviceRegister,
    DeviceUpdate,
)
from app.services.benchmark import sanitize_and_score
from app.services.fraud import FraudEngine
from app.services.heartbeat import HeartbeatProcessor
from app.utils.ids import device_handle, new_ulid
from app.utils.time import utcnow


router = APIRouter(prefix="/devices", tags=["devices"])


@router.post("/register", response_model=DeviceDetail, status_code=status.HTTP_201_CREATED)
async def register_device(
    payload: DeviceRegister,
    principal: Principal = Depends(require_user),
    session: AsyncSession = Depends(get_session),
) -> DeviceDetail:
    fraud = FraudEngine()
    verdict = await fraud.evaluate_device_registration(
        session, owner_id=principal.user.id, lan_fingerprint=payload.lan_fingerprint
    )
    fraud.assert_safe_or_raise(verdict)

    # Hard gate: caller must hold a verified LanClaim for this LAN. Without
    # this anyone could pair-all an open WiFi (Starbucks etc.) and steal
    # earnings from the legitimate owners.
    from app.services.lan_claim import LanClaimService

    await LanClaimService().assert_user_can_register_on_lan(
        session,
        user_id=principal.user.id,
        lan_fingerprint=payload.lan_fingerprint,
    )

    async with transactional(session):
        device = Device(
            id=new_ulid(),
            handle=device_handle(),
            owner_id=principal.user.id,
            label=payload.label,
            device_class=payload.device_class,
            status=DeviceStatus.pending_attestation,
            vendor=payload.vendor,
            model=payload.model,
            firmware=payload.firmware,
            os=payload.os,
            arch=payload.arch,
            public_key=payload.public_key,
            consents=payload.consents.model_dump(),
            capabilities=payload.capabilities.model_dump(),
            lan_fingerprint=payload.lan_fingerprint,
            reliability_score=max(0.05, 0.5 - verdict.weight_penalty),
            trust_score=max(0.05, 0.5 - verdict.weight_penalty),
        )
        session.add(device)
        await session.flush()
        await session.refresh(device)

    return DeviceDetail.model_validate(device)


@router.get("", response_model=list[DevicePublic])
async def list_my_devices(
    principal: Principal = Depends(require_user),
    session: AsyncSession = Depends(get_session),
) -> list[DevicePublic]:
    rows = (await session.execute(
        select(Device).where(Device.owner_id == principal.user.id).order_by(Device.created_at.desc())
    )).scalars().all()
    return [DevicePublic.model_validate(d) for d in rows]


@router.get("/{device_id}", response_model=DeviceDetail)
async def get_device(
    device_id: str,
    principal: Principal = Depends(require_user),
    session: AsyncSession = Depends(get_session),
) -> DeviceDetail:
    device = await session.get(Device, device_id)
    if device is None:
        raise NotFoundError("device not found").as_http()
    if device.owner_id != principal.user.id and not principal.is_admin:
        raise PermissionError_("not your device").as_http()
    return DeviceDetail.model_validate(device)


@router.patch("/{device_id}", response_model=DevicePublic)
async def update_device(
    device_id: str,
    payload: DeviceUpdate,
    principal: Principal = Depends(require_user),
    session: AsyncSession = Depends(get_session),
) -> DevicePublic:
    async with transactional(session):
        device = await session.get(Device, device_id, with_for_update=True)
        if device is None:
            raise NotFoundError("device not found").as_http()
        if device.owner_id != principal.user.id and not principal.is_admin:
            raise PermissionError_("not your device").as_http()
        if payload.label is not None:
            device.label = payload.label
        if payload.auto_join_enabled is not None:
            device.auto_join_enabled = payload.auto_join_enabled
        if payload.consents is not None:
            device.consents = payload.consents.model_dump()
    return DevicePublic.model_validate(device)


@router.post("/{device_id}/decommission", response_model=DevicePublic)
async def decommission(
    device_id: str,
    principal: Principal = Depends(require_user),
    session: AsyncSession = Depends(get_session),
) -> DevicePublic:
    async with transactional(session):
        device = await session.get(Device, device_id, with_for_update=True)
        if device is None:
            raise NotFoundError("device not found").as_http()
        if device.owner_id != principal.user.id and not principal.is_admin:
            raise PermissionError_("not your device").as_http()
        if device.status == DeviceStatus.leased:
            raise ConflictError("cannot decommission leased device").as_http()
        device.status = DeviceStatus.decommissioned
        device.auto_join_enabled = False
    return DevicePublic.model_validate(device)


@router.post("/{device_id}/issue-token", response_model=dict)
async def issue_device_token(
    device_id: str,
    principal: Principal = Depends(require_user),
    session: AsyncSession = Depends(get_session),
) -> dict:
    device = await session.get(Device, device_id)
    if device is None:
        raise NotFoundError("device not found").as_http()
    if device.owner_id != principal.user.id and not principal.is_admin:
        raise PermissionError_("not your device").as_http()
    token, exp = mint_token(
        sub=device.id,
        kind="device",
        device_id=device.id,
        scope=["device.heartbeat", "device.work"],
        extra={"owner_id": device.owner_id},
    )
    return {"token": token, "expires_in": exp, "device_handle": device.handle}


@router.post("/{device_id}/benchmark", response_model=DeviceDetail)
async def submit_benchmark(
    device_id: str,
    payload: DeviceBenchmarkSubmit,
    principal: Principal = Depends(require_user),
    session: AsyncSession = Depends(get_session),
) -> DeviceDetail:
    async with transactional(session):
        device = await session.get(Device, device_id, with_for_update=True)
        if device is None:
            raise NotFoundError("device not found").as_http()
        if device.owner_id != principal.user.id and not principal.is_admin:
            raise PermissionError_("not your device").as_http()

        outcome = sanitize_and_score(
            payload, device.device_class, historical_h100eq=device.h100_equivalent or None
        )
        s = outcome.sanitized

        device.cpu_cores = s.cpu_cores
        device.cpu_ghz = s.cpu_ghz
        device.ram_mb = s.ram_mb
        device.storage_gb = s.storage_gb
        device.gpu_model = s.gpu_model
        device.gpu_vram_mb = s.gpu_vram_mb
        device.cpu_gflops = s.cpu_gflops
        device.gpu_gflops = s.gpu_gflops
        device.hash_mhs_sha256 = s.hash_mhs_sha256
        device.hash_mhs_argon2 = s.hash_mhs_argon2
        device.network_mbps_down = s.network_mbps_down
        device.network_mbps_up = s.network_mbps_up
        device.network_latency_ms = s.network_latency_ms
        device.avg_idle_hours_per_day = s.avg_idle_hours_per_day
        device.h100_equivalent = outcome.h100_equivalent
        device.last_benchmark_at = utcnow()
        device.metadata_ = {
            **(device.metadata_ or {}),
            "benchmark_anomalies": outcome.anomalies,
            "benchmark_confidence": outcome.confidence,
        }
        if device.status in (DeviceStatus.benchmarking, DeviceStatus.pending_attestation):
            device.status = DeviceStatus.idle
    return DeviceDetail.model_validate(device)


@router.post("/me/heartbeat", status_code=status.HTTP_204_NO_CONTENT)
async def device_heartbeat(
    payload: DeviceHeartbeat,
    principal: Principal = Depends(require_device),
    session: AsyncSession = Depends(get_session),
) -> None:
    processor = HeartbeatProcessor()
    await processor.ingest(session, principal.device, payload)
