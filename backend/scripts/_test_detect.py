import sys
sys.path.insert(0, r"C:\Users\wonma\Documents\electromesh\backend")
from scripts.host_hijack import detect_gateway, detect_link_local_v6
our_ip, our_mac, gw_ip, gw_mac = detect_gateway()
print(f"[+] us:      {our_ip}  ({our_mac})")
print(f"[+] gateway: {gw_ip}  ({gw_mac})")
ll = detect_link_local_v6()
print(f"[+] link-local v6: {ll}")
