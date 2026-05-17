"""http_diag.py -- sniff TCP/80 traffic to verify iPhone hits our portal."""
import sys, time
from scapy.all import sniff, IP, TCP  # type: ignore

iface = sys.argv[1] if len(sys.argv) > 1 else "Wi-Fi 2"
duration = int(sys.argv[2]) if len(sys.argv) > 2 else 30

print(f"[http_diag] sniffing TCP/80 on {iface} for {duration}s")
syn_seen = {}
get_seen = []

def on_pkt(p):
    if not p.haslayer(TCP) or not p.haslayer(IP):
        return
    t = p[TCP]
    src, dst = p[IP].src, p[IP].dst
    # SYN to our port 80
    if dst == "192.168.0.22" and t.dport == 80 and (t.flags & 0x02) and not (t.flags & 0x10):
        syn_seen[src] = syn_seen.get(src, 0) + 1
    # HTTP request (look for "GET ")
    if t.dport == 80 and bytes(t.payload).startswith(b"GET "):
        line = bytes(t.payload).split(b"\r\n", 1)[0].decode("ascii", "replace")
        get_seen.append((src, line))

sniff(iface=iface, prn=on_pkt, store=False, timeout=duration,
      filter="tcp port 80")
print("\n====== TCP/80 SYN to 192.168.0.22 ======")
for src, n in sorted(syn_seen.items()):
    print(f"  {src:18}  {n} SYNs")
print(f"\n====== HTTP GETs ({len(get_seen)}) ======")
for src, line in get_seen[:30]:
    print(f"  {src:18}  {line[:100]}")
