"""iphone_trace.py -- forensic: where is iPhone actually connecting?"""
import sys, time
from collections import Counter
from scapy.all import sniff, IP, TCP, Ether  # type: ignore

iface = sys.argv[1] if len(sys.argv) > 1 else "Wi-Fi 2"
target_mac = sys.argv[2].lower() if len(sys.argv) > 2 else "80:96:98:26:1b:57"
duration = int(sys.argv[3]) if len(sys.argv) > 3 else 25

print(f"[iphone_trace] tracking outbound TCP from MAC {target_mac} for {duration}s")
syns = Counter()  # (dst_ip, dst_port, dst_mac) -> count

def on_pkt(p):
    if not p.haslayer(Ether) or not p.haslayer(IP) or not p.haslayer(TCP):
        return
    if p[Ether].src.lower() != target_mac:
        return
    t = p[TCP]
    if (t.flags & 0x02) and not (t.flags & 0x10):  # SYN only
        key = (p[IP].dst, t.dport, p[Ether].dst.lower())
        syns[key] += 1

sniff(iface=iface, prn=on_pkt, store=False, timeout=duration,
      filter="tcp[tcpflags] & tcp-syn != 0 and tcp[tcpflags] & tcp-ack = 0")
print(f"\n===== iPhone-originated TCP SYNs =====")
ours = "04:d3:b0:14:79:0e"
gw = "70:5d:cc:b1:7e:40"
for (dst_ip, dport, dst_mac), n in syns.most_common(30):
    via = " VIA-US" if dst_mac == ours else " VIA-GATEWAY" if dst_mac == gw else " VIA-OTHER"
    print(f"  {n:4}  {dst_ip}:{dport}  eth_dst={dst_mac}{via}")
