"""Sniff incoming DNS traffic to prove ARP-spoofing actually routed TV
DNS to us."""
import sys, time
sys.path.insert(0, r"C:\Users\wonma\Documents\electromesh\backend")
from scapy.all import sniff, DNS, DNSQR, IP, UDP

TV_IPS = {"192.168.0.12": "LG TV", "192.168.0.16": "Sony TV"}
ALL_SRCS: dict[str, int] = {}
TV_QUERIES = []

def cb(pkt):
    if not pkt.haslayer(IP) or not pkt.haslayer(UDP) or not pkt.haslayer(DNS):
        return
    if pkt[UDP].dport != 53:    # only inbound queries to a DNS server
        return
    src = pkt[IP].src
    dst = pkt[IP].dst
    ALL_SRCS[src] = ALL_SRCS.get(src, 0) + 1
    qname = ""
    if pkt[DNS].qd:
        try: qname = pkt[DNS].qd.qname.decode("ascii", errors="replace").rstrip(".")
        except Exception: qname = "?"
    tag = TV_IPS.get(src, "")
    flag = "  <-- TV!!" if src in TV_IPS else ""
    print(f"  {src:<15} -> {dst:<15} dns?{qname}  {tag}{flag}")
    if src in TV_IPS:
        TV_QUERIES.append((time.time(), src, qname))

print("Sniffing UDP/53 traffic for 30 seconds on Wi-Fi 2...")
print("Watching for queries from 192.168.0.12 (LG) and 192.168.0.16 (Sony)")
print()
sniff(iface="Wi-Fi 2", filter="udp port 53", prn=cb, timeout=30, store=0)
print()
print(f"=== summary ===")
print(f"Total query sources: {len(ALL_SRCS)}")
for src, n in sorted(ALL_SRCS.items(), key=lambda x: -x[1]):
    tag = TV_IPS.get(src, "")
    print(f"  {src:<15} {n:>4} queries  {tag}")
print()
print(f"TV-originated queries reaching us: {len(TV_QUERIES)}")
for ts, src, q in TV_QUERIES:
    print(f"  +{ts:.0f}  {src}  {q}")
