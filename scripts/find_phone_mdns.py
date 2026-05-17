"""Discover Android ADB Wireless via mDNS."""
import time, socket, sys
try:
    from zeroconf import Zeroconf, ServiceBrowser, ServiceListener
except ImportError:
    print("[mdns] zeroconf missing, installing...", flush=True)
    import subprocess
    subprocess.check_call([sys.executable, "-m", "pip", "install", "zeroconf", "--quiet"])
    from zeroconf import Zeroconf, ServiceBrowser, ServiceListener

SERVICES = [
    "_adb-tls-connect._tcp.local.",
    "_adb-tls-pairing._tcp.local.",
    "_adb._tcp.local.",
    "_companion-link._tcp.local.",
    "_googlecast._tcp.local.",
    "_workstation._tcp.local.",
    "_ssh._tcp.local.",
    "_sftp-ssh._tcp.local.",
]

found = []

class L(ServiceListener):
    def __init__(self, svc):
        self.svc = svc
    def add_service(self, zc, type_, name):
        info = zc.get_service_info(type_, name, timeout=2000)
        if info:
            ips = [socket.inet_ntoa(a) for a in info.addresses if len(a) == 4]
            entry = {"svc": type_, "name": name, "port": info.port, "ips": ips, "props": {k.decode(errors="ignore"): (v.decode(errors="ignore") if isinstance(v, bytes) else v) for k, v in info.properties.items()}}
            found.append(entry)
            print(f"[mdns] {type_} -> {ips}:{info.port}  name={name}", flush=True)
    def update_service(self, *a, **k): pass
    def remove_service(self, *a, **k): pass

zc = Zeroconf()
browsers = [ServiceBrowser(zc, s, L(s)) for s in SERVICES]
print(f"[mdns] browsing {len(SERVICES)} service types for 15s...", flush=True)
time.sleep(15)
zc.close()

print("\n=== mDNS RESULTS ===")
for f in found:
    print(f)
if not found:
    print("(no mDNS services discovered — check AP isolation / mDNS-relay on KT router)")
