"""AdminGateway core — discovery → connector dispatch → status tracking."""

from __future__ import annotations

import asyncio
import time
from dataclasses import dataclass, field
from enum import Enum
from typing import Any, Protocol

from app.logging_setup import get_logger
from app.services.network_scanner import DeviceFingerprint

log = get_logger("admin_gateway")


class ApprovalStatus(str, Enum):
    """Lifecycle of a single device's approval."""
    pending          = "pending"           # discovered, queued
    approving        = "approving"          # connector is acting on it
    approved         = "approved"           # bootstrap done, device claimed
    needs_bootstrap  = "needs_bootstrap"    # waiting on one physical action (TV remote / phone tap)
    cached           = "cached"             # previously bootstrapped, ready to go zero-touch
    failed           = "failed"             # connector failed
    unsupported      = "unsupported"        # no connector matches


@dataclass(slots=True)
class ApprovalResult:
    """What a connector returns after attempting an approval."""
    success: bool
    status: ApprovalStatus
    connector: str
    bootstrap_needed: bool = False
    bootstrap_action: str = ""          # human-readable: "Press OK on TV remote"
    bootstrap_timeout_s: int = 0
    error: str = ""
    extra: dict[str, Any] = field(default_factory=dict)


@dataclass(slots=True)
class PendingApproval:
    """One row in the gateway approval queue."""
    device_ip: str
    device_mac: str
    device_type: str
    vendor: str
    inferred_connector: str = ""
    status: ApprovalStatus = ApprovalStatus.pending
    bootstrap_required: bool = False
    bootstrap_action: str = ""
    last_attempt_at: float = 0.0
    last_error: str = ""
    extra: dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        return {
            "device_ip": self.device_ip,
            "device_mac": self.device_mac,
            "device_type": self.device_type,
            "vendor": self.vendor,
            "connector": self.inferred_connector,
            "status": self.status.value,
            "bootstrap_required": self.bootstrap_required,
            "bootstrap_action": self.bootstrap_action,
            "last_attempt_at": self.last_attempt_at,
            "last_error": self.last_error,
            "extra": self.extra,
        }


class Connector(Protocol):
    """Each vendor / device-class implements one of these."""
    name: str

    def matches(self, fp: DeviceFingerprint) -> bool: ...

    async def approve(
        self, fp: DeviceFingerprint, *, portal_base_url: str,
    ) -> ApprovalResult: ...

    async def status(self, fp: DeviceFingerprint) -> dict[str, Any]:
        """Optional: live status query (cached key present? online?)."""
        return {}


class AdminGateway:
    """Central orchestrator.  Singleton via get_admin_gateway()."""

    def __init__(self) -> None:
        self._connectors: list[Connector] = []
        self._queue: dict[str, PendingApproval] = {}   # ip -> PendingApproval
        self._cloud_logins: dict[str, dict[str, Any]] = {}  # vendor -> token info
        self._portal_base_url: str = "http://127.0.0.1"

    # ── connector registry ────────────────────────────────────────────

    def register(self, connector: Connector) -> None:
        self._connectors.append(connector)
        log.info("gateway.connector_registered", name=connector.name)

    def list_connectors(self) -> list[str]:
        return [c.name for c in self._connectors]

    def _pick_connector(self, fp: DeviceFingerprint) -> Connector | None:
        for c in self._connectors:
            try:
                if c.matches(fp):
                    return c
            except Exception as e:
                log.warning("gateway.matches_err", connector=c.name, err=str(e))
        return None

    # ── cloud login records ──────────────────────────────────────────

    def record_cloud_login(self, vendor: str, info: dict[str, Any]) -> None:
        """Persist that the user signed into ``vendor`` cloud on this laptop."""
        self._cloud_logins[vendor] = {**info, "logged_in_at": time.time()}
        log.info("gateway.cloud_login_recorded", vendor=vendor)

    def cloud_logins(self) -> dict[str, dict[str, Any]]:
        # Strip access tokens for safe API exposure
        return {
            v: {k: i[k] for k in ("logged_in_at",) if k in i}
            for v, i in self._cloud_logins.items()
        }

    def has_cloud_login(self, vendor: str) -> bool:
        return vendor in self._cloud_logins

    # ── queue management ──────────────────────────────────────────────

    def set_portal_base_url(self, url: str) -> None:
        self._portal_base_url = url

    def rebuild_queue(self, fingerprints: list[DeviceFingerprint]) -> dict[str, Any]:
        """Re-scan the connector list against discovered devices and
        produce a fresh approval queue."""
        new_queue: dict[str, PendingApproval] = {}
        for fp in fingerprints:
            if fp.is_gateway:
                continue
            prev = self._queue.get(fp.ip)
            connector = self._pick_connector(fp)
            entry = PendingApproval(
                device_ip=fp.ip,
                device_mac=fp.mac,
                device_type=fp.inferred_type,
                vendor=fp.vendor,
                inferred_connector=connector.name if connector else "",
                status=(
                    prev.status if prev and prev.status in (
                        ApprovalStatus.approved, ApprovalStatus.cached,
                    ) else (ApprovalStatus.pending if connector
                            else ApprovalStatus.unsupported)
                ),
                last_attempt_at=prev.last_attempt_at if prev else 0.0,
                last_error=prev.last_error if prev else "",
            )
            new_queue[fp.ip] = entry
        self._queue = new_queue
        return self.snapshot()

    def queue(self) -> list[dict[str, Any]]:
        return [e.to_dict() for e in self._queue.values()]

    def snapshot(self) -> dict[str, Any]:
        rows = list(self._queue.values())
        by_status: dict[str, int] = {}
        for r in rows:
            by_status[r.status.value] = by_status.get(r.status.value, 0) + 1
        return {
            "total": len(rows),
            "by_status": by_status,
            "connectors": self.list_connectors(),
            "cloud_logins": list(self._cloud_logins.keys()),
            "portal_base_url": self._portal_base_url,
            "queue": [r.to_dict() for r in rows],
        }

    # ── approval execution ───────────────────────────────────────────

    async def approve_one(
        self, device_ip: str, *, fp_lookup,
    ) -> dict[str, Any]:
        """Run the matching connector against a single device.

        ``fp_lookup`` is a callable ``(ip) -> DeviceFingerprint | None``
        — typically ``get_network_scanner().get_device``.
        """
        entry = self._queue.get(device_ip)
        if entry is None:
            return {"ok": False, "error": "not in queue"}
        fp = fp_lookup(device_ip)
        if fp is None:
            return {"ok": False, "error": "device dropped off LAN"}
        connector = self._pick_connector(fp)
        if connector is None:
            entry.status = ApprovalStatus.unsupported
            return {"ok": False, "error": "no matching connector"}

        entry.status = ApprovalStatus.approving
        entry.last_attempt_at = time.time()

        try:
            result = await connector.approve(fp, portal_base_url=self._portal_base_url)
        except Exception as e:
            entry.status = ApprovalStatus.failed
            entry.last_error = str(e)[:200]
            log.warning("gateway.approve_crash", ip=device_ip, err=str(e))
            return {"ok": False, "error": entry.last_error}

        entry.status = result.status
        entry.bootstrap_required = result.bootstrap_needed
        entry.bootstrap_action = result.bootstrap_action
        entry.last_error = result.error
        entry.extra = result.extra
        return {
            "ok": result.success,
            "status": result.status.value,
            "bootstrap_needed": result.bootstrap_needed,
            "bootstrap_action": result.bootstrap_action,
            "bootstrap_timeout_s": result.bootstrap_timeout_s,
            "error": result.error,
            "connector": result.connector,
        }

    async def approve_all(
        self, *, fp_lookup, max_parallel: int = 4,
    ) -> dict[str, Any]:
        """Run all eligible queue entries concurrently."""
        candidates = [
            e for e in self._queue.values()
            if e.status in (ApprovalStatus.pending, ApprovalStatus.failed,
                            ApprovalStatus.needs_bootstrap, ApprovalStatus.cached)
            and e.inferred_connector
        ]
        sem = asyncio.Semaphore(max_parallel)

        async def _one(entry: PendingApproval) -> tuple[str, dict[str, Any]]:
            async with sem:
                r = await self.approve_one(entry.device_ip, fp_lookup=fp_lookup)
                return entry.device_ip, r

        results = await asyncio.gather(
            *[_one(e) for e in candidates], return_exceptions=False,
        )
        return {
            "attempted": len(candidates),
            "results": {ip: r for ip, r in results},
            "snapshot": self.snapshot(),
        }


# ── singleton ──────────────────────────────────────────────────────

_GATEWAY: AdminGateway | None = None


def get_admin_gateway() -> AdminGateway:
    global _GATEWAY
    if _GATEWAY is None:
        _GATEWAY = AdminGateway()
        _bootstrap_default_connectors(_GATEWAY)
    return _GATEWAY


def _bootstrap_default_connectors(gw: AdminGateway) -> None:
    """Register the built-in connectors.  Imported lazily to avoid
    circular imports during package init."""
    from app.services.admin_gateway.connectors import (
        LgWebosConnector,
        RokuConnector,
        ChromecastConnector,
        CaptiveByodConnector,
    )
    gw.register(LgWebosConnector())
    gw.register(RokuConnector())
    gw.register(ChromecastConnector())
    gw.register(CaptiveByodConnector())   # catch-all for phones/laptops
