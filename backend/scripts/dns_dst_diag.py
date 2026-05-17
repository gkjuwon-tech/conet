"""dns_dst_diag.py -- where is iPhone actually sending its DNS?"""
import sys
from collections import Counter
from scapy.all import sniff, IP, UDP, DNS, DNSQR  # type: ignore

iface = sys.argv[1] if len(sys.argv) > 1 else "Wi-Fi 2"
target_ip = sys.argv[2] if len(sys.argv) > 2 else "192.168.0.54"
duration = int(sys.argv[3]) if len(sys.argv) > 3 else 30

dst_counter: Counter[str] = Counter()
total = 0

def on_pkt(p):
    global total
    if not p.haslayer(DNS) or p[DNS].qr != 0:
        return
    if not p.haslayer(IP) or p[IP].src != target_ip:
        return
    total += 1
    dst_counter[p[IP].dst] += 1

print(f"[dns_dst_diag] sniffing DNS queries from {target_ip} for {duration}s")
sniff(iface=iface, prn=on_pkt, store=False, timeout=duration,
      filter=f"udp port 53 and src host {target_ip}")
print(f"\n===== {total} DNS queries from {target_ip} =====")
for dst, n in dst_counter.most_common():
    label = (
        " <-- US (DHCP win!)"  if dst == "192.168.0.22"
        else " <-- gateway"     if dst == "192.168.0.1"
        else " <-- public"
    )
    print(f"  {n:5}  -> {dst}{label}")
