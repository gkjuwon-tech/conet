"""Shell session orchestrator — RunPod-style interactive workloads."""
from __future__ import annotations

import asyncio
import secrets
from dataclasses import dataclass
from datetime import datetime, timedelta
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import get_settings
from app.db.models.cluster import ClusterMembership
from app.db.models.device import Device
from app.db.models.enterprise import Enterprise
from app.db.models.job import Job, JobKind
from app.db.models.shell_session import ShellSession, ShellSessionStatus
from app.db.session import transactional
from app.exceptions import ConflictError, InsufficientCapacity, NotFoundError
from app.logging_setup import get_logger
from app.utils.ids import new_ulid
from app.utils.time import utcnow


log = get_logger("shell_proxy")


@dataclass(slots=True)
class ShellSpec:
    image: str | None
    workdir: str | None
    env: dict[str, str]
    cmd: str | None
    cpu_cap_pct: float
    memory_mb_cap: int
    disk_mb_cap: int
    network_egress_mbps_cap: float
    ttl_seconds: int


class ShellOrchestrator:
    def __init__(self) -> None:
        self.settings = get_settings()

    async def create(
        self,
        session: AsyncSession,
        *,
        enterprise: Enterprise,
        job: Job,
        spec: ShellSpec,
        cluster_id: str,
    ) -> ShellSession:
        if job.kind != JobKind.compute_shell:
            raise ConflictError("job kind is not compute.shell")
        ttl = max(60, min(spec.ttl_seconds, self.settings.shell_session_max_ttl_seconds))

        active_count = (
            await session.execute(
                select(ShellSession).where(
                    ShellSession.enterprise_id == enterprise.id,
                    ShellSession.status.in_(
                        (
                            ShellSessionStatus.pending,
                            ShellSessionStatus.waiting_device,
                            ShellSessionStatus.active,
                        )
                    ),
                )
            )
        ).scalars().all()
        if len(active_count) >= self.settings.shell_session_max_concurrent_per_enterprise:
            raise InsufficientCapacity(
                "concurrent shell session cap reached",
                detail={
                    "limit": self.settings.shell_session_max_concurrent_per_enterprise,
                    "active": len(active_count),
                },
            )

        # Pick the highest-h100 device on the cluster.
        rows = list(
            (
                await session.execute(
                    select(Device, ClusterMembership)
                    .join(ClusterMembership, ClusterMembership.device_id == Device.id)
                    .where(
                        ClusterMembership.cluster_id == cluster_id,
                        ClusterMembership.is_active.is_(True),
                    )
                    .order_by(Device.h100_equivalent.desc())
                )
            ).all()
        )
        if not rows:
            raise InsufficientCapacity("no devices in selected cluster")
        device: Device = rows[0][0]

        async with transactional(session):
            shell = ShellSession(
                id=new_ulid(),
                enterprise_id=enterprise.id,
                job_id=job.id,
                device_id=device.id,
                status=ShellSessionStatus.waiting_device,
                enterprise_token=secrets.token_urlsafe(32),
                device_token=secrets.token_urlsafe(32),
                image=spec.image,
                workdir=spec.workdir,
                env=spec.env or {},
                cmd=spec.cmd,
                cpu_cap_pct=spec.cpu_cap_pct,
                memory_mb_cap=spec.memory_mb_cap,
                disk_mb_cap=spec.disk_mb_cap,
                network_egress_mbps_cap=spec.network_egress_mbps_cap,
                created_at_ts=utcnow(),
                expires_at=utcnow() + timedelta(seconds=ttl),
                rate_usd_per_hour=_compute_shell_rate(device),
            )
            session.add(shell)
            log.info(
                "shell.created",
                shell_id=shell.id,
                job_id=job.id,
                device_id=device.id,
                rate_usd_hour=shell.rate_usd_per_hour,
            )
            return shell

    async def lookup_by_enterprise_token(
        self, session: AsyncSession, *, token: str
    ) -> ShellSession:
        sess = (
            await session.execute(
                select(ShellSession).where(ShellSession.enterprise_token == token)
            )
        ).scalar_one_or_none()
        if sess is None:
            raise NotFoundError("invalid enterprise shell token")
        return sess

    async def lookup_by_device_token(
        self, session: AsyncSession, *, token: str
    ) -> ShellSession:
        sess = (
            await session.execute(
                select(ShellSession).where(ShellSession.device_token == token)
            )
        ).scalar_one_or_none()
        if sess is None:
            raise NotFoundError("invalid device shell token")
        return sess

    async def mark_device_attached(
        self, session: AsyncSession, *, shell_id: str
    ) -> ShellSession:
        async with transactional(session):
            sess = await session.get(ShellSession, shell_id, with_for_update=True)
            if sess is None:
                raise NotFoundError("shell gone")
            now = utcnow()
            if sess.status not in (
                ShellSessionStatus.waiting_device,
                ShellSessionStatus.active,
            ):
                raise ConflictError(f"shell in status {sess.status}")
            sess.status = ShellSessionStatus.active
            if sess.activated_at is None:
                sess.activated_at = now
            sess.last_io_at = now
            return sess

    async def mark_io(
        self,
        session: AsyncSession,
        *,
        shell_id: str,
        bytes_in: int = 0,
        bytes_out: int = 0,
    ) -> None:
        async with transactional(session):
            sess = await session.get(ShellSession, shell_id, with_for_update=True)
            if sess is None:
                return
            sess.bytes_in += int(bytes_in)
            sess.bytes_out += int(bytes_out)
            sess.last_io_at = utcnow()

    async def close(
        self,
        session: AsyncSession,
        *,
        shell_id: str,
        reason: str | None = None,
        revoked: bool = False,
    ) -> ShellSession:
        async with transactional(session):
            sess = await session.get(ShellSession, shell_id, with_for_update=True)
            if sess is None:
                raise NotFoundError("shell gone")
            if sess.status in (
                ShellSessionStatus.closed,
                ShellSessionStatus.expired,
                ShellSessionStatus.revoked,
            ):
                return sess
            now = utcnow()
            if sess.activated_at is not None:
                sess.runtime_seconds = max(
                    sess.runtime_seconds, int((now - sess.activated_at).total_seconds())
                )
            sess.metered_cents = int(
                round(sess.rate_usd_per_hour * (sess.runtime_seconds / 3600.0) * 100.0)
            )
            sess.closed_at = now
            sess.status = (
                ShellSessionStatus.revoked if revoked else ShellSessionStatus.closed
            )
            sess.revoked_reason = reason
            log.info(
                "shell.closed",
                shell_id=shell_id,
                runtime_seconds=sess.runtime_seconds,
                metered_cents=sess.metered_cents,
                reason=reason,
            )
            return sess


def _compute_shell_rate(device: Device) -> float:
    """A flat USD/hr to charge for an interactive shell on this device.

    We deliberately make shells more expensive than batch — users get to do
    whatever they want, including idle.
    """
    base = max(device.h100_equivalent, 1e-4)
    # Shell premium = 3× compute spot; floor of $0.05/hr so even a Pi pays.
    return round(max(0.05, base * 7.0), 4)
