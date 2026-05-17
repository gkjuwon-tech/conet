"""
FakeDNS — transparent background DNS interception for device onboarding.

Binds a lightweight asyncio UDP listener that silently redirects DNS A-record
queries to the ElectroMesh backend IP.  NO captive-portal HTML is served,
no user-visible page is displayed on the target device.  The redirect is
entirely internal: once the device's HTTP traffic lands on our gateway the
*backend* returns a silent 204 or a zero-pixel response, while the
``claim_service`` registers a "phone-home" event.

The device owner never sees anything unusual — their TV / console / IoT
gadget simply resolves every domain to our gateway for a brief window,
the agent registers in the background, and normal DNS resumes once the
claim is finalised.

Lifecycle:
    server = get_fake_dns_server("192.168.1.42")
    await server.start()       # binds UDP on dns_port
    ...                        # devices start resolving via us
    await server.stop()        # release the port

Privileges:  Port 53 requires root/admin on most OSes.  We default to
5354 for development and document how to redirect real port 53 via
``iptables -t nat`` or the Windows ``netsh`` equivalent.
"""

from __future__ import annotations

import asyncio
import socket
import struct
import time
from collections import deque
from dataclasses import dataclass, field
from typing import Any, Callable

from app.logging_setup import get_logger

log = get_logger("fakedns")


# ── Data types ────────────────────────────────────────────────────────────

@dataclass(slots=True)
class DNSQueryEvent:
    """Single intercepted DNS lookup — stored for diagnostics only."""
    domain: str
    source_ip: str
    source_port: int
    timestamp: float = field(default_factory=time.time)


# ── Low-level DNS helpers ─────────────────────────────────────────────────

def _parse_dns_question(data: bytes) -> tuple[str, int, int, int] | None:
    """Extract (domain, qtype, qclass, end_offset) from a DNS packet.

    Returns ``None`` for malformed or non-query packets.
    """
    if len(data) < 12:
        return None

    flags = struct.unpack("!H", data[2:4])[0]
    qr = (flags >> 15) & 1
    opcode = (flags >> 11) & 0xF
    if qr != 0 or opcode != 0:          # not a standard query
        return None

    qdcount = struct.unpack("!H", data[4:6])[0]
    if qdcount < 1:
        return None

    pos = 12
    labels: list[str] = []
    while pos < len(data):
        length = data[pos]
        if length == 0:
            pos += 1
            break
        if pos + 1 + length > len(data):
            return None
        labels.append(data[pos + 1 : pos + 1 + length].decode("ascii", errors="replace"))
        pos += 1 + length

    if pos + 4 > len(data):
        return None

    qtype = struct.unpack("!H", data[pos : pos + 2])[0]
    qclass = struct.unpack("!H", data[pos + 2 : pos + 4])[0]
    return ".".join(labels), qtype, qclass, pos + 4


def _build_a_response(
    query: bytes,
    end_of_question: int,
    redirect_ip_bytes: bytes,
    ttl: int = 30,
) -> bytes:
    """Build a minimal DNS response pointing the queried name at *redirect_ip*."""
    txn_id = query[:2]
    # QR=1  AA=1  RD=1  RA=1  → 0x8580
    header = txn_id + struct.pack(
        "!HHHHH",
        0x8580,          # flags
        1,               # QDCOUNT
        1,               # ANCOUNT
        0,               # NSCOUNT
        0,               # ARCOUNT
    )
    question = query[12:end_of_question]
    answer = (
        b"\xc0\x0c"                            # name pointer → question
        + struct.pack("!HHI", 1, 1, ttl)       # TYPE=A  CLASS=IN  TTL
        + struct.pack("!H", 4)                 # RDLENGTH
        + redirect_ip_bytes
    )
    return header + question + answer


def _build_nxdomain_response(query: bytes, end_of_question: int) -> bytes:
    """Build an NXDOMAIN response — required to disable iCloud Private Relay
    on iOS so the captive-portal probe falls back to our hijacked DNS.

    Apple's own guidance for captive-portal operators: respond NXDOMAIN to
    ``mask.icloud.com`` and ``mask-h2.icloud.com`` so the device disables
    Private Relay on this network. Without this, iOS 15+ tunnels DNS through
    Apple's relays and our FakeDNS never sees the CPD probes.
    """
    txn_id = query[:2]
    # QR=1  AA=1  RD=1  RA=1  RCODE=3 (NXDOMAIN) → 0x8583
    header = txn_id + struct.pack("!HHHHH", 0x8583, 1, 0, 0, 0)
    question = query[12:end_of_question]
    return header + question


# ── Protocol ──────────────────────────────────────────────────────────────

# Domains we explicitly NXDOMAIN to force iOS off Private Relay onto the
# captive-portal fallback path. AAAA queries are also NXDOMAIN'd so dual-stack
# devices don't sneak around via IPv6.
NXDOMAIN_HOSTS: frozenset[str] = frozenset({
    "mask.icloud.com",
    "mask-h2.icloud.com",
    "mask-api.icloud.com",
    "mask-canary.icloud.com",
})


class _DNSProtocol(asyncio.DatagramProtocol):
    """Stateless UDP responder — answers A-record queries with *redirect_ip*."""

    __slots__ = ("_redirect_bytes", "_on_query", "transport", "_queries")

    def __init__(
        self,
        redirect_ip: str,
        on_query: Callable[[DNSQueryEvent], None] | None = None,
    ) -> None:
        self._redirect_bytes = socket.inet_aton(redirect_ip)
        self._on_query = on_query
        self.transport: asyncio.DatagramTransport | None = None
        self._queries = 0

    def connection_made(self, transport: asyncio.DatagramTransport) -> None:  # noqa: D102
        self.transport = transport

    def datagram_received(self, data: bytes, addr: tuple[str, int]) -> None:  # noqa: D102
        parsed = _parse_dns_question(data)
        if parsed is None:
            return

        domain, qtype, qclass, end_pos = parsed
        dom_lower = domain.lower().rstrip(".")

        # Private Relay kill-switch: NXDOMAIN so iOS disables iCloud Private
        # Relay on this network and our captive-portal hijack can fire.
        if dom_lower in NXDOMAIN_HOSTS:
            if self.transport is not None:
                self.transport.sendto(
                    _build_nxdomain_response(data, end_pos), addr,
                )
            return

        # AAAA (28) queries: respond NXDOMAIN so iOS doesn't dual-stack around
        # our IPv4 hijack. (Returning empty NOERROR also works but NXDOMAIN
        # makes the negative cache hit cleaner.)
        if qtype == 28 and qclass == 1:
            if self.transport is not None:
                self.transport.sendto(
                    _build_nxdomain_response(data, end_pos), addr,
                )
            return

        # Only hijack A-record (1) IN-class (1) queries
        if qtype != 1 or qclass != 1:
            return

        response = _build_a_response(data, end_pos, self._redirect_bytes)
        if self.transport is not None:
            self.transport.sendto(response, addr)
            self._queries += 1

        if self._on_query is not None:
            self._on_query(DNSQueryEvent(
                domain=domain,
                source_ip=addr[0],
                source_port=addr[1],
            ))


# ── Server ────────────────────────────────────────────────────────────────

class FakeDnsServer:
    """Background-only DNS interceptor — no user-visible pages."""

    def __init__(
        self,
        redirect_ip: str,
        dns_port: int = 5354,
    ) -> None:
        self._redirect_ip = redirect_ip
        self._dns_port = dns_port

        self._transport: asyncio.DatagramTransport | None = None
        self._protocol: _DNSProtocol | None = None
        self._running = False
        self._started_at = 0.0

        # Ring-buffer of last 256 intercepted queries (diagnostic)
        self._recent_queries: deque[DNSQueryEvent] = deque(maxlen=256)

    # ── public ────────────────────────────────────────────────────────

    @property
    def is_running(self) -> bool:
        return self._running

    @property
    def stats(self) -> dict[str, Any]:
        return {
            "running": self._running,
            "redirect_ip": self._redirect_ip,
            "dns_port": self._dns_port,
            "started_at": self._started_at,
            "uptime_s": round(time.time() - self._started_at, 1) if self._running else 0,
            "total_queries": self._protocol._queries if self._protocol else 0,
            "recent_sources": list({q.source_ip for q in self._recent_queries}),
        }

    async def start(self) -> None:
        if self._running:
            return

        loop = asyncio.get_running_loop()
        # Try port 53 first (what devices actually query). If we can't bind
        # — no admin, port taken, or Docker bridge isolation — fall back to
        # the configured dev port (default 5354) so the rest of the stack
        # still has something to point at. The fallback is logged loudly
        # because it means CPD probes from real devices won't reach us
        # unless something redirects UDP/53 → 5354 at the host level.
        attempts: list[int] = []
        if self._dns_port != 53:
            attempts.append(53)
        attempts.append(self._dns_port)

        bound_port: int | None = None
        last_err: Exception | None = None
        for port in attempts:
            try:
                self._transport, self._protocol = await loop.create_datagram_endpoint(
                    lambda: _DNSProtocol(self._redirect_ip, on_query=self._record_query),
                    local_addr=("0.0.0.0", port),
                    family=socket.AF_INET,
                )
                bound_port = port
                break
            except Exception as e:
                last_err = e
                log.warning("fakedns.bind_failed", port=port, err=str(e))

        if bound_port is None:
            raise RuntimeError(
                f"FakeDNS could not bind any of {attempts}: {last_err!r}"
            )

        self._dns_port = bound_port
        self._running = True
        self._started_at = time.time()
        log.info(
            "fakedns.started",
            redirect_ip=self._redirect_ip,
            port=bound_port,
            on_privileged_port=(bound_port == 53),
        )

    async def stop(self) -> None:
        if not self._running:
            return
        if self._transport is not None:
            self._transport.close()
            self._transport = None
        self._protocol = None
        self._running = False
        log.info("fakedns.stopped")

    # ── private ───────────────────────────────────────────────────────

    def _record_query(self, event: DNSQueryEvent) -> None:
        self._recent_queries.append(event)


# ── Singleton ─────────────────────────────────────────────────────────────

_DNS_SERVER: FakeDnsServer | None = None


def get_fake_dns_server(redirect_ip: str = "127.0.0.1") -> FakeDnsServer:
    global _DNS_SERVER
    if _DNS_SERVER is None:
        _DNS_SERVER = FakeDnsServer(redirect_ip=redirect_ip)
    return _DNS_SERVER
