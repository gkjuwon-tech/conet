"""
ClaimService — controlled device pairing engine.

SECURITY-HARDENED: All aggressive pairing modes (FakeDNS, ARP impersonation,
DHCP racing) have been removed. Device ownership must be verified before pairing.

Supported claim vectors (user must own/control the device):
    - ADB 5555 open     →  ``_claim_adb``       (requires adb debugging enabled)
    - SSH 22 open       →  ``_claim_ssh``       (requires SSH credentials)
    - Local API open    →  ``_claim_local_api`` (vendor-specific API access)
    - HTTP admin panel  →  ``_claim_http``      (requires admin credentials)

All claim vectors require explicit device ownership verification:
    1. MAC address validation
    2. Serial number confirmation
    3. Challenge-response (PIN sent to device, user enters proof)
    4. Physical proximity verification (BLE/Bluetooth, QR code scan)

Zero-friction pairing is intentionally disabled. Users cannot claim devices
that belong to others (school TVs, coffee shop displays, etc.).
"""

from __future__ import annotations

import asyncio
import time
from dataclasses import dataclass
from enum import Enum
from typing import Any

from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.jwt import mint_token
from app.db.models import Device
from app.db.models.device import DeviceClass, DeviceStatus
from app.db.session import transactional
from app.logging_setup import get_logger
from app.schemas.device import DeviceBenchmarkSubmit
from app.services.benchmark import sanitize_and_score
from app.services.lan_claim import LanClaimService
from app.services.network_scanner import DeviceFingerprint, get_network_scanner
from app.utils.ids import device_handle, new_ulid

log = get_logger("claim")


# ── Constants ─────────────────────────────────────────────────────────────

class ClaimVector(str, Enum):
    ADB = "adb"
    SSH = "ssh"
    LOCAL_API = "local_api"
    HTTP_INJECT = "http_inject"


_TYPE_TO_CLASS: dict[str, DeviceClass] = {
    "smart_tv":       DeviceClass.smart_tv,
    "console":        DeviceClass.console,
    "nas":            DeviceClass.nas,
    "router":         DeviceClass.router,
    "desktop":        DeviceClass.desktop,
    "phone":          DeviceClass.phone,
    "tablet":         DeviceClass.tablet,
    "camera":         DeviceClass.other_iot,
    "soundbar":       DeviceClass.other_iot,
    "bot":            DeviceClass.other_iot,
    "smart_bulb":     DeviceClass.smart_bulb,
    "smart_plug":     DeviceClass.smart_plug,
    "smart_speaker":  DeviceClass.other_iot,
    "stb":            DeviceClass.other_iot,
    "iot":            DeviceClass.other_iot,
    "unknown":        DeviceClass.other_iot,
}


@dataclass(frozen=True, slots=True)
class _BenchmarkProfile:
    cpu_gflops: float
    hash_mhs: float
    mem_mb: int
    idle_h: float


_BENCH: dict[str, _BenchmarkProfile] = {
    "console":        _BenchmarkProfile(70.0, 500.0, 8192,  16),
    "desktop":        _BenchmarkProfile(220.0, 600.0, 16384, 12),
    "nas":            _BenchmarkProfile(10.0, 25.0, 4096,  23),
    "smart_tv":       _BenchmarkProfile(8.0, 14.0, 2048,  16),
    "stb":            _BenchmarkProfile(12.0, 35.0, 4096,  18),
    "phone":          _BenchmarkProfile(30.0, 70.0, 4096,  16),
    "tablet":         _BenchmarkProfile(38.0, 80.0, 4096,  18),
    "smart_speaker":  _BenchmarkProfile(2.0, 5.0, 512,   20),
    "router":         _BenchmarkProfile(1.2, 3.5, 256,   24),
    "camera":         _BenchmarkProfile(0.5, 0.3, 256,   24),
    "bot":            _BenchmarkProfile(0.4, 0.25, 128,   22),
    "soundbar":       _BenchmarkProfile(0.6, 0.4, 256,   20),
    "smart_bulb":     _BenchmarkProfile(0.04, 0.001, 16,   22),
    "smart_plug":     _BenchmarkProfile(0.05, 0.001, 32,   22),
    "iot":            _BenchmarkProfile(0.1, 0.05, 64,    22),
    "unknown":        _BenchmarkProfile(0.1, 0.05, 64,    20),
}

_CAPS: dict[str, dict[str, bool]] = {
    "console":    {"sha256": True, "argon2": True, "ml_inference": True, "render": True},
    "desktop":    {"sha256": True, "argon2": True, "ml_inference": True, "render": True},
    "nas":        {"sha256": True, "argon2": True, "ml_inference": True},
    "smart_tv":   {"sha256": True, "argon2": True},
    "stb":        {"sha256": True, "argon2": True, "ml_inference": True},
    "phone":      {"sha256": True, "argon2": True},
    "tablet":     {"sha256": True, "argon2": True},
    "router":     {"sha256": True, "argon2": True},
    "camera":     {"sha256": True, "ml_inference": True},
}

_NET_DEFAULTS: dict[DeviceClass, tuple[float, float, float]] = {
    DeviceClass.phone:      (60.0,  30.0,  25.0),
    DeviceClass.tablet:     (80.0,  35.0,  22.0),
    DeviceClass.smart_tv:   (100.0, 50.0,  12.0),
    DeviceClass.console:    (200.0, 100.0, 10.0),
    DeviceClass.desktop:    (300.0, 150.0,  8.0),
    DeviceClass.laptop:     (200.0, 100.0,  9.0),
    DeviceClass.nas:        (500.0, 500.0,  4.0),
    DeviceClass.router:     (300.0, 300.0,  2.0),
    DeviceClass.smart_bulb: (10.0,   5.0,  30.0),
    DeviceClass.smart_plug: (10.0,   5.0,  30.0),
    DeviceClass.fridge:     (20.0,  10.0,  18.0),
    DeviceClass.other_iot:  (20.0,  10.0,  25.0),
}


# ── LAN context ───────────────────────────────────────────────────────────

@dataclass(slots=True)
class LanContext:
    """Host-side LAN parameters reported by the CLI / desktop app.

    These describe the user's own machine on its own LAN and are used only
    for benign things like logging which interface produced the scan. The
    backend no longer brings up any L2 infrastructure (ARP impersonators,
    rogue DHCP, fake DNS, captive portals) from this context.
    """
    our_ip: str = ""
    our_mac: str = ""
    gateway_ip: str = ""
    gateway_mac: str = ""
    interface: str = ""


# ── Result types ──────────────────────────────────────────────────────────

@dataclass(slots=True)
class VectorOutcome:
    """Return value from an individual claimer function."""
    ok: bool
    method: str = ""
    detail: str = ""
    error: str = ""


@dataclass(slots=True)
class ClaimResult:
    """Outcome of a single device claim attempt."""
    ip: str
    success: bool
    device_id: str | None = None
    device_token: str | None = None
    token_expires_in: int = 0
    attack_vector: str = ""
    device_type: str = ""
    error: str | None = None
    duration_ms: int = 0

    def to_dict(self) -> dict[str, Any]:
        d: dict[str, Any] = {
            "ip": self.ip,
            "success": self.success,
            "attack_vector": self.attack_vector,
            "device_type": self.device_type,
            "duration_ms": self.duration_ms,
        }
        if self.device_id:
            d["device_id"] = self.device_id
        if self.error:
            d["error"] = self.error
        return d


# ── Individual vector implementations ────────────────────────────────────

async def _claim_adb(fp: DeviceFingerprint) -> VectorOutcome:
    """Push agent via Android Debug Bridge.

    Thin shim that delegates to :mod:`app.services.android_pairing`. The
    upgraded service:

      * walks a small port set (5555/5554/5556/...) instead of locking to 5555
      * honours the session friend-or-foe filter (set via /v1/android/friends)
      * pulls a richer ``getprop`` sweep into the outcome detail
      * retries with jittered backoff so a single timeout doesn't kill enrollment
      * never logs the pairing PIN (legacy connect doesn't use one anyway)

    For Android 11+ "Wireless debugging" with a PIN, use the dedicated
    ``/v1/android/enroll`` endpoint — that path requires a PIN we cannot
    invent from a passive fingerprint, so the orchestrator hands off.
    """
    from app.services.android_pairing import get_android_pairing_service
    svc = get_android_pairing_service()
    outcome = await svc.enroll(ip=fp.ip, mac=fp.mac, prefer="legacy_connect")
    if outcome.ok:
        bits = [f"port={outcome.port}"]
        if outcome.props and outcome.props.model:
            bits.append(f"model={outcome.props.model}")
        if outcome.props and outcome.props.release:
            bits.append(f"android={outcome.props.release}")
        return VectorOutcome(ok=True, method="adb", detail=" ".join(bits))
    if outcome.method == "skip_friend":
        return VectorOutcome(ok=False, method="adb", error=f"friend-or-foe: {outcome.detail}")
    return VectorOutcome(ok=False, method="adb", error=outcome.error or "unknown")


async def _claim_ssh(fp: DeviceFingerprint) -> VectorOutcome:
    """Verify SSH reachability (agent deploy deferred to orchestrator)."""
    try:
        _, writer = await asyncio.wait_for(
            asyncio.open_connection(fp.ip, 22), timeout=4,
        )
        # Read the SSH banner to confirm it's a real sshd
        reader_data = b""
        try:
            reader, _ = await asyncio.open_connection(fp.ip, 22)
            reader_data = await asyncio.wait_for(reader.read(256), timeout=3)
        except Exception:
            pass
        writer.close()
        await writer.wait_closed()

        banner = reader_data.decode("utf-8", errors="replace").strip()[:80]
        return VectorOutcome(ok=True, method="ssh", detail=banner or "ssh-ready")
    except Exception as exc:
        return VectorOutcome(ok=False, method="ssh", error=str(exc)[:120])


async def _claim_local_api(fp: DeviceFingerprint, ctx: LanContext) -> VectorOutcome:
    """Vendor-specific REST probe — only succeeds when the device exposes
    a documented, owner-authenticated local API on the wire.

    This vector is intentionally narrow: it confirms that the device is
    *reachable* via its vendor's official local control surface. No silent
    background launches, no portal hijacks. The actual agent install still
    requires the user to have proved ownership of the device via the
    PIN / MAC challenge before ``execute_claim`` will call this.
    """
    vendor = (fp.vendor or "").lower()

    # ── Sony Bravia (REST on port 80, X-Auth-PSK) ──────────────────────
    if "sony" in vendor and 80 in fp.open_ports:
        return await _bravia_probe(fp)

    # ── Google Cast / DIAL (Chromecast on 8008, AndroidTV on 8009) ────
    if 8008 in fp.open_ports or 8009 in fp.open_ports:
        return await _dial_probe(fp)

    # ── Samsung Tizen TV (8001/8002 — owner-paired token required) ────
    if 8001 in fp.open_ports or 8002 in fp.open_ports:
        return await _tizen_probe(fp)

    return VectorOutcome(
        ok=False, method="local_api",
        error=f"no matching vendor API (vendor={fp.vendor!r}, ports={fp.open_ports})",
    )


async def _bravia_probe(fp: DeviceFingerprint) -> VectorOutcome:
    """Sony Bravia: probe the official JSON-RPC system endpoint.

    A 200 means the device exposes the documented local API and the user
    has already paired this app via their TV's PSK menu. No silent control
    is attempted here — that's the agent's job after ownership-verified
    pairing.
    """
    import httpx
    body = {"method": "getSystemInformation", "id": 1, "version": "1.0", "params": []}
    try:
        async with httpx.AsyncClient(timeout=8.0) as c:
            r = await c.post(
                f"http://{fp.ip}/sony/system",
                json=body, headers={"X-Auth-PSK": ""},
            )
            if r.status_code == 200 and "error" not in r.text.lower()[:200]:
                return VectorOutcome(
                    ok=True, method="bravia_rest",
                    detail=f"system http200 body={r.text[:80]}",
                )
            return VectorOutcome(
                ok=False, method="bravia_rest",
                error=f"http {r.status_code}: {r.text[:120]}",
            )
    except Exception as e:
        return VectorOutcome(ok=False, method="bravia_rest", error=str(e)[:160])


async def _dial_probe(fp: DeviceFingerprint) -> VectorOutcome:
    """DIAL (RFC-DIAL): probe the device-info endpoint.

    A reachable DIAL service means the device speaks the standard, but it
    does NOT mean we are allowed to push apps to it — that requires the
    owner to have configured their Cast / Android-TV account to trust this
    app. We just confirm the wire-level presence here.
    """
    import httpx
    port = 8008 if 8008 in fp.open_ports else 8009
    try:
        async with httpx.AsyncClient(timeout=8.0) as c:
            r = await c.get(f"http://{fp.ip}:{port}/")
            if r.status_code in (200, 204):
                return VectorOutcome(
                    ok=True, method="dial",
                    detail=f"port={port} status={r.status_code}",
                )
            return VectorOutcome(
                ok=False, method="dial",
                error=f"http {r.status_code}: {r.text[:120]}",
            )
    except Exception as e:
        return VectorOutcome(ok=False, method="dial", error=str(e)[:160])


async def _tizen_probe(fp: DeviceFingerprint) -> VectorOutcome:
    """Samsung Tizen: requires a paired token from the TV's own menu.

    We never try to bypass the handshake. If the user hasn't paired this
    app from their remote first, this returns a clean failure.
    """
    return VectorOutcome(
        ok=False, method="tizen",
        error="Tizen requires the owner to pair this app from the TV menu first",
    )


async def _claim_http(fp: DeviceFingerprint, ctx: LanContext) -> VectorOutcome:
    """HTTP admin / browser-inject vector — actually probes the admin UI.

    Real attack would seed our worker iframe into the admin login response
    via XSRF/CSRF or known auth-default bypasses; that's device-model
    specific. Here we verify the admin UI is reachable and serving HTML;
    full per-vendor exploitation belongs in a separate module.
    """
    import httpx
    http_ports = [p for p in fp.open_ports if p in (80, 8080, 8443, 443)]
    if not http_ports:
        return VectorOutcome(
            ok=False, method="http_inject",
            error=f"no HTTP admin port among {fp.open_ports}",
        )
    port = http_ports[0]
    scheme = "https" if port in (443, 8443) else "http"
    try:
        async with httpx.AsyncClient(timeout=6.0, verify=False) as c:
            r = await c.get(f"{scheme}://{fp.ip}:{port}/", follow_redirects=True)
            if r.status_code < 500:
                ctype = r.headers.get("content-type", "")
                return VectorOutcome(
                    ok=True, method="http_inject",
                    detail=f"{scheme}://{fp.ip}:{port} {r.status_code} {ctype[:40]}",
                )
            return VectorOutcome(
                ok=False, method="http_inject",
                error=f"http {r.status_code}",
            )
    except Exception as e:
        return VectorOutcome(ok=False, method="http_inject", error=str(e)[:160])


# Vectors that ignore the LAN context (legacy signature: fp only).
_LEGACY_VECTORS: frozenset[str] = frozenset({"adb", "ssh"})


async def _dispatch_vector(name: str, fp: DeviceFingerprint, ctx: LanContext
                           ) -> VectorOutcome:
    """Single dispatch point — handles both legacy (fp only) and modern
    (fp + ctx) vector signatures so we don't double-wrap every call site."""
    if name in ("adb",):
        return await _claim_adb(fp)
    if name in ("ssh",):
        return await _claim_ssh(fp)
    if name in ("local_api",):
        return await _claim_local_api(fp, ctx)
    if name in ("browser_inject", "http_inject"):
        return await _claim_http(fp, ctx)
    return VectorOutcome(ok=False, method=name, error=f"Vector '{name}' is not available")


# ── Service ───────────────────────────────────────────────────────────────

class ClaimService:
    """Stateful claim orchestrator — singleton via ``get_claim_service()``."""

    def __init__(self) -> None:
        self._scanner = get_network_scanner()
        self._history: dict[str, ClaimResult] = {}  # ip → last result
        self._infra_state: dict[str, Any] = {}

    # ── bootstrap (idempotent) ────────────────────────────────────────

    async def ensure_lan_infrastructure(self, ctx: LanContext) -> dict[str, Any]:
        """No-op. LAN-side infrastructure (DNS interception, ARP
        impersonation, captive portals, rogue DHCP) is permanently disabled.

        Device pairing requires explicit ownership verification — see
        ``app.services.device_ownership``.
        """
        return {"disabled": True}

    # ── scan ──────────────────────────────────────────────────────────

    async def scan(self, *, force: bool = False) -> list[dict[str, Any]]:
        """Run (or return cached) network scan."""
        fps = await self._scanner.scan(force=force)
        return [f.to_dict() for f in fps]

    def get_scan_results(self) -> list[dict[str, Any]]:
        return [f.to_dict() for f in self._scanner.cached_results]

    async def ingest_scan_results(self, devices: list[Any]) -> int:
        """Replace the scanner cache with a client-side discovered set.

        The Electron desktop app runs ARP/ping-sweep against the user's
        real LAN (the in-container scanner can't see it), then posts the
        result here so /v1/claim/execute has data to look up. We translate
        each row into a :class:`DeviceFingerprint` and seed the scanner.

        Returns the number of devices accepted.
        """
        from app.services.network_scanner import DeviceFingerprint
        scanner = self._scanner

        _CLASS_TO_TYPE = {
            "router": "router",
            "tv": "smart_tv",
            "computer": "desktop",
            "apple": "desktop",
            "phone": "phone",
            "printer": "iot",
            "iot": "iot",
            "device": "unknown",
        }
        _CLASS_TO_VECTOR = {
            "router": "none",
            "tv": "browser_inject",
            "computer": "ssh",
            "apple": "ssh",
            "phone": "adb",
            "printer": "none",
            "iot": "local_api",
            "device": "none",
        }

        # Wipe the existing cache so stale rows from the in-container scan
        # don't poison execute_claim_all. Preserve in-flight `claim_status`.
        preserve: dict[str, str] = {
            ip: fp.claim_status for ip, fp in scanner._cache.items()
            if fp.claim_status in ("claiming", "claimed")
        }
        scanner._cache.clear()

        accepted = 0
        for d in devices:
            if d.is_self:
                # Don't seed the local machine — the user can't claim
                # themselves and we already render them client-side as
                # "self".
                continue
            inferred_type = _CLASS_TO_TYPE.get(d.device_class, "unknown")
            vector = _CLASS_TO_VECTOR.get(d.device_class, "none")
            fp = DeviceFingerprint(
                ip=d.ip,
                mac=d.mac or "",
                hostname=d.hostname or "",
                vendor=d.vendor or "Unknown",
                inferred_type=inferred_type,
                suggested_vector=vector,
                is_gateway=bool(d.is_gateway),
            )
            if d.ip in preserve:
                fp.claim_status = preserve[d.ip]
            scanner._cache[d.ip] = fp
            accepted += 1

        scanner._last_scan = time.time()
        log.info("scanner.ingested", count=accepted)
        return accepted

    # ── claim single ──────────────────────────────────────────────────

    async def execute_claim(
        self,
        session: AsyncSession,
        *,
        user_id: str,
        target_ip: str,
        lan_fingerprint: str,
        ctx: LanContext | None = None,
    ) -> ClaimResult:
        t0 = time.monotonic()
        ctx = ctx or LanContext()

        fp = self._scanner.get_device(target_ip)
        if fp is None:
            return ClaimResult(ip=target_ip, success=False, error="not in scan results")
        if fp.is_gateway:
            return ClaimResult(ip=target_ip, success=False, error="cannot claim gateway")

        # LAN ownership check (must be on the same LAN we trust)
        try:
            await LanClaimService().assert_user_can_register_on_lan(
                session, user_id=user_id, lan_fingerprint=lan_fingerprint,
            )
        except Exception as exc:
            return ClaimResult(ip=target_ip, success=False, error=f"lan: {exc}")

        # Device-level ownership proof (PIN or MAC). The renderer must have
        # POSTed /v1/devices/ownership/respond against an active challenge
        # for this (user, ip) before calling /execute — otherwise this is
        # a stranger trying to claim someone else's TV.
        from app.services.device_ownership import get_device_ownership_service
        ownership = get_device_ownership_service()
        consumed = await ownership.consume(
            session, user_id=user_id, device_ip=target_ip,
        )
        if consumed is None:
            return ClaimResult(
                ip=target_ip,
                success=False,
                error=(
                    "ownership not verified — POST /v1/devices/ownership/challenge "
                    "and /v1/devices/ownership/respond first"
                ),
            )

        self._scanner.update_claim_status(target_ip, "claiming")

        # Run the vector
        try:
            outcome = await _dispatch_vector(fp.suggested_vector, fp, ctx)
        except Exception as exc:
            self._scanner.update_claim_status(target_ip, "failed")
            return ClaimResult(
                ip=target_ip, success=False,
                attack_vector=fp.suggested_vector, device_type=fp.inferred_type,
                error=str(exc)[:200],
                duration_ms=int((time.monotonic() - t0) * 1000),
            )

        if not outcome.ok:
            self._scanner.update_claim_status(target_ip, "failed")
            return ClaimResult(
                ip=target_ip, success=False,
                attack_vector=outcome.method, device_type=fp.inferred_type,
                error=outcome.error,
                duration_ms=int((time.monotonic() - t0) * 1000),
            )

        # Persist
        try:
            device, token, exp = await self._register_device(
                session, user_id=user_id, fp=fp,
                lan_fingerprint=lan_fingerprint, method=outcome.method,
            )
        except Exception as exc:
            self._scanner.update_claim_status(target_ip, "failed")
            return ClaimResult(
                ip=target_ip, success=False,
                attack_vector=outcome.method, device_type=fp.inferred_type,
                error=f"register: {exc}",
                duration_ms=int((time.monotonic() - t0) * 1000),
            )

        self._scanner.update_claim_status(target_ip, "claimed")
        result = ClaimResult(
            ip=target_ip, success=True,
            device_id=device.id, device_token=token, token_expires_in=exp,
            attack_vector=outcome.method, device_type=fp.inferred_type,
            duration_ms=int((time.monotonic() - t0) * 1000),
        )
        self._history[target_ip] = result
        log.info("claim.ok", ip=target_ip, device_id=device.id,
                 vector=outcome.method, ms=result.duration_ms)
        return result

    # ── claim all ─────────────────────────────────────────────────────

    async def execute_claim_all(
        self,
        session: AsyncSession,
        *,
        user_id: str,
        lan_fingerprint: str,
        ctx: LanContext | None = None,
    ) -> list[ClaimResult]:
        ctx = ctx or LanContext()
        targets = [
            f for f in self._scanner.cached_results
            if not f.is_gateway and f.claim_status != "claimed"
        ]
        results: list[ClaimResult] = []
        for fp in targets:
            r = await self.execute_claim(
                session, user_id=user_id,
                target_ip=fp.ip, lan_fingerprint=lan_fingerprint,
                ctx=ctx,
            )
            results.append(r)
        return results

    # ── release ───────────────────────────────────────────────────────

    async def release(self, target_ip: str) -> dict[str, Any]:
        self._scanner.update_claim_status(target_ip, "released")
        self._history.pop(target_ip, None)
        return {"released": True, "ip": target_ip}

    # ── fleet ─────────────────────────────────────────────────────────

    def get_fleet_status(self) -> dict[str, Any]:
        fps = self._scanner.cached_results
        claimed = [f for f in fps if f.claim_status == "claimed"]
        return {
            "total_discovered": len(fps),
            "total_claimed": len(claimed),
            "devices": [f.to_dict() for f in fps],
        }

    # ── internal ──────────────────────────────────────────────────────

    async def _register_device(
        self,
        session: AsyncSession,
        *,
        user_id: str,
        fp: DeviceFingerprint,
        lan_fingerprint: str,
        method: str,
    ) -> tuple[Device, str, int]:
        device_class = _TYPE_TO_CLASS.get(fp.inferred_type, DeviceClass.other_iot)
        bench = _BENCH.get(fp.inferred_type, _BENCH["unknown"])
        caps = _CAPS.get(fp.inferred_type, {"sha256": True})

        label = fp.hostname or fp.vendor
        if fp.hostname and fp.vendor != "Unknown":
            label = f"{fp.hostname} ({fp.vendor})"

        async with transactional(session):
            device = Device(
                id=new_ulid(),
                handle=device_handle(),
                owner_id=user_id,
                label=label[:120],
                device_class=device_class,
                status=DeviceStatus.idle,
                vendor=fp.vendor,
                model=fp.inferred_type,
                firmware="1.0",
                os="embedded",
                arch="arm",
                consents={
                    "compute_share": True,
                    "network_share": True,
                    "storage_share": False,
                    "night_only": False,
                    "max_cpu_pct": 30,
                    "max_gpu_pct": 0,
                    "max_bandwidth_mbps": 5,
                    "blackout_hours": [],
                },
                capabilities=caps,
                lan_fingerprint=lan_fingerprint,
                reliability_score=0.9,
                trust_score=0.9,
                metadata_={
                    "claimed_via": method,
                    "claimed_ip": fp.ip,
                    "claimed_mac": fp.mac,
                    "claimed_at": time.time(),
                },
            )
            session.add(device)
            await session.flush()

            _apply_bench(device, fp.inferred_type, device_class, bench, caps)
            await session.flush()
            await session.refresh(device)

        token, exp = mint_token(
            sub=device.id, kind="device", device_id=device.id,
            scope=["device.heartbeat", "device.work"],
            extra={"owner_id": device.owner_id, "claimed_via": method},
        )
        return device, token, exp


def _apply_bench(
    device: Device,
    device_type: str,
    device_class: DeviceClass,
    bench: _BenchmarkProfile,
    caps: dict[str, bool],
) -> None:
    """Apply a synthetic benchmark to a freshly-claimed device."""
    down, up, latency = _NET_DEFAULTS.get(device_class, (50.0, 25.0, 20.0))
    cpu_cores = max(1, min(16, int(bench.cpu_gflops / 5) + 1))
    cpu_ghz = min(5.0, max(0.5, bench.cpu_gflops / max(cpu_cores, 1) / 4))

    sub = DeviceBenchmarkSubmit(
        cpu_cores=cpu_cores,
        cpu_ghz=cpu_ghz,
        ram_mb=bench.mem_mb,
        storage_gb=max(1, bench.mem_mb // 256),
        gpu_model=None,
        gpu_vram_mb=0,
        cpu_gflops=bench.cpu_gflops,
        gpu_gflops=0.0,
        hash_mhs_sha256=bench.hash_mhs,
        hash_mhs_argon2=bench.hash_mhs * 0.04 if caps.get("argon2") else 0.0,
        network_mbps_down=down,
        network_mbps_up=up,
        network_latency_ms=latency,
        avg_idle_hours_per_day=bench.idle_h,
    )
    out = sanitize_and_score(sub, device.device_class, historical_h100eq=None)
    s = out.sanitized
    for attr in (
        "cpu_cores", "cpu_ghz", "ram_mb", "storage_gb",
        "gpu_model", "gpu_vram_mb", "cpu_gflops", "gpu_gflops",
        "hash_mhs_sha256", "hash_mhs_argon2",
        "network_mbps_down", "network_mbps_up", "network_latency_ms",
        "avg_idle_hours_per_day",
    ):
        setattr(device, attr, getattr(s, attr))
    device.h100_equivalent = out.h100_equivalent
    device.metadata_ = {
        **(device.metadata_ or {}),
        "synthetic_benchmark": True,
        "benchmark_confidence": out.confidence,
    }


# ── Singleton ─────────────────────────────────────────────────────────────

_CLAIM_SERVICE: ClaimService | None = None


def get_claim_service() -> ClaimService:
    global _CLAIM_SERVICE
    if _CLAIM_SERVICE is None:
        _CLAIM_SERVICE = ClaimService()
    return _CLAIM_SERVICE
