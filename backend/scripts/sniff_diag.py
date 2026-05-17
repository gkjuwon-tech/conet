"""sniff_diag.py — passive wire sniffer for ARP / DNS / DHCP traffic.

Prints every DNS query, every DHCP frame, and every ARP-request on the LAN
interface. Used to verify whether ARP poison is actually being honored by
target devices (i.e., do their DNS queries arrive at our NIC?).

Run for ~30 seconds, then Ctrl-C. No port binding required — pure L2 sniff
via Npcap.
"""
from __future__ import annotations
import sys, time
from collections import Counter
from scapy.all import sniff, conf, DNS, DNSQR, DHCP, ARP, IP, IPv6  # type: ignore

iface = sys.argv[1] if len(sys.argv) > 1 else "Wi-Fi 2"
duration = int(sys.argv[2]) if len(sys.argv) > 2 else 30
our_ip = "192.168.0.22"
our_mac = "04:d3:b0:14:79:0e"

src_counter: Counter[str] = Counter()
dns_by_src: dict[str, list[str]] = {}
dhcp_sources: set[str] = set()
arp_sources: set[str] = set()

def on_pkt(p):
    try:
        if p.haslayer(DNS) and p[DNS].qr == 0:
            src = p[IP].src if p.haslayer(IP) else (p[IPv6].src if p.haslayer(IPv6) else "?")
            dst = p[IP].dst if p.haslayer(IP) else (p[IPv6].dst if p.haslayer(IPv6) else "?")
            qname = p[DNSQR].qname.decode("ascii", "replace").rstrip(".") if p.haslayer(DNSQR) else "?"
            src_counter[src] += 1
            dns_by_src.setdefault(src, []).append(f"-> {dst}  {qname}")
        if p.haslayer(DHCP):
            try:
                mac = p[0].src if hasattr(p[0], "src") else "?"
                dhcp_sources.add(mac)
            except Exception: pass
        if p.haslayer(ARP) and p[ARP].op == 1:  # who-has
            arp_sources.add(f"{p[ARP].psrc} ({p[ARP].hwsrc}) asks for {p[ARP].pdst}")
    except Exception as e:
        print("err:", e)

print(f"[diag] sniffing iface={iface!r} for {duration}s -- our_ip={our_ip}")
print(f"[diag] conf.iface={conf.iface}")
sniff(iface=iface, prn=on_pkt, store=False, timeout=duration,
      filter="udp port 53 or udp port 67 or udp port 68 or arp")
print("\n========== RESULT ==========")
print(f"DNS query sources: {len(src_counter)}")
for src, n in src_counter.most_common():
    note = " <-- this is us" if src == our_ip else ""
    print(f"  {src:18}  {n:4} queries{note}")
    for q in dns_by_src[src][:3]:
        print(f"       {q}")
print(f"\nDHCP frames seen from {len(dhcp_sources)} MACs:")
for m in dhcp_sources: print(f"  {m}")
print(f"\nARP requests seen ({len(arp_sources)}):")
for a in list(arp_sources)[:20]: print(f"  {a}")
