"""ElectroMesh Phone Dispatcher — infinite ADB automation loop.

Once the user pairs his Samsung SM-S948N once (one-time 6-digit code),
this script runs forever:
  - Auto-rediscovers connect port via mDNS each cycle (Android randomizes after every reboot)
  - Reconnects with `adb connect` if disconnected
  - Pulls live diagnostics from phone: dumpsys wifi, ip route, getprop, /proc/net/route
  - Toggles airplane mode (svc wifi disable/enable) to force CPD re-probe and re-trigger
    captive portal popup — which hits OUR portal_server.py since DNS hijack is live
  - Opens captive portal URL in Chrome whenever a fresh DHCP cycle is detected
  - Reports portal_stats per-device

Run:
    backend\\.venv\\Scripts\\python.exe scripts\\phone_dispatcher.py
"""
import subprocess, time, json, os, sys, socket, re
from pathlib import Path

ADB = os.path.expanduser(r"~\platform-tools\adb.exe")
DEVICE_NAME = "SM-S948N"
PORTAL_URL = "http://192.168.0.22/v1/claim/portal/check"
BACKEND_STATS = "http://192.168.0.22/v1/claim/portal/stats"
CYCLE_SEC = 30
LOG = Path(os.environ.get("TEMP", ".")) / "electromesh_phone.log"

def log(msg):
    line = f"[{time.strftime('%H:%M:%S')}] {msg}"
    print(line, flush=True)
    try:
        with open(LOG, "a", encoding="utf-8") as f:
            f.write(line + "\n")
    except Exception:
        pass

def discover():
    """Return (ip, port) via mDNS or None."""
    try:
        from zeroconf import Zeroconf, ServiceBrowser, ServiceListener
    except ImportError:
        return None
    hits = []
    class L(ServiceListener):
        def add_service(self, zc, type_, name):
            info = zc.get_service_info(type_, name, timeout=1500)
            if info:
                ips = [socket.inet_ntoa(a) for a in info.addresses if len(a) == 4]
                if ips:
                    hits.append((ips[0], info.port, dict(info.properties)))
        def update_service(self, *a, **k): pass
        def remove_service(self, *a, **k): pass
    zc = Zeroconf()
    ServiceBrowser(zc, "_adb-tls-connect._tcp.local.", L())
    time.sleep(4)
    zc.close()
    # prefer SM-S948N
    for ip, p, props in hits:
        name = props.get(b"name", b"").decode(errors="ignore") if isinstance(props.get(b"name"), bytes) else str(props.get(b"name", ""))
        if DEVICE_NAME in name:
            return ip, p
    return hits[0][:2] if hits else None

def adb(*args, timeout=15):
    try:
        r = subprocess.run([ADB] + list(args), capture_output=True, text=True, timeout=timeout)
        return r.returncode, (r.stdout or "") + (r.stderr or "")
    except Exception as e:
        return -1, str(e)

def connect(ip, port):
    rc, out = adb("connect", f"{ip}:{port}")
    return ("connected" in out.lower() or "already" in out.lower()), out.strip()

def devices():
    rc, out = adb("devices")
    return out

def shell(cmd, timeout=15):
    rc, out = adb("-s", f"{CONNECTED[0]}:{CONNECTED[1]}", "shell", cmd, timeout=timeout)
    return out

CONNECTED = None  # (ip, port)

def diag():
    """Run one diagnostic snapshot."""
    snap = {}
    snap["wifi_state"] = shell("dumpsys wifi | grep -E 'mNetworkInfo|curState|SSID|Frequency' | head -20")
    snap["ip_addr"] = shell("ip -4 addr show wlan0 2>/dev/null | head -5")
    snap["route"] = shell("ip route 2>/dev/null | head -5")
    snap["dns"] = shell("getprop | grep -E 'net.dns|wlan' | head -10")
    snap["captive"] = shell("dumpsys connectivity | grep -i -E 'captive|portal|validat' | head -10")
    snap["bssid"] = shell("dumpsys wifi | grep -i bssid | head -3")
    return snap

WIFI_NETID_RE = re.compile(r"NetworkAgentInfo\{network\{(\d+)\}[^}]*?WIFI", re.IGNORECASE | re.DOTALL)

def get_wifi_netid():
    """Extract WiFi network netId from dumpsys connectivity. Returns str or None."""
    out = shell("dumpsys connectivity", timeout=8)
    # Look for WIFI-transport network agent. Format varies by Android version.
    # Try multiple patterns.
    for line in out.splitlines():
        if "WIFI" in line.upper() and "network{" in line:
            m = re.search(r"network\{(\d+)\}", line)
            if m:
                return m.group(1)
    # Fallback: grep ActiveNetwork
    m = re.search(r"Active default network[^\n]*?network\{(\d+)\}", out)
    if m:
        return m.group(1)
    return None

def force_cpd():
    """Force Captive Portal Detection re-evaluation WITHOUT killing wifi.

    Multi-pronged attack:
      1. `cmd connectivity reevaluate <netId>` — official Android 10+ API to
         re-run captive portal probe on the given network.
      2. From phone shell, curl our hijacked /generate_204 probe URL — guarantees
         portal hit even if reevaluate skipped.
      3. `am start VIEW http://...` — opens Chrome on captive portal as last resort.
    """
    nid = get_wifi_netid()
    log(f"  wifi netId={nid}")
    if nid:
        r = shell(f"cmd connectivity reevaluate {nid}", timeout=6)
        log(f"  reevaluate({nid}): {r.strip()[:120]}")

    # Direct curl to our portal's CPD endpoint. portal_server.py has /generate_204.
    # When phone curls this and gets 200+body, on next OS-level probe it'll re-evaluate.
    # More importantly we log the hit and force a fresh portal_url that the system tray pops.
    probe = "http://192.168.0.22/generate_204"
    r = shell(f"toybox wget -q -O - {probe} 2>/dev/null || curl -s -o /dev/null -w '%{{http_code}}' {probe}", timeout=6)
    log(f"  probe /generate_204 → {r.strip()[:80]}")

    # Also hit the actual portal landing once so backend ledger logs an active session.
    r = shell(f"toybox wget -q -O - {PORTAL_URL} 2>/dev/null | head -c 200 || curl -s {PORTAL_URL} | head -c 200", timeout=8)
    log(f"  portal hit: {r.strip()[:120]}")

def open_portal():
    """Open ElectroMesh portal in default browser via adb intent (foreground tab)."""
    r = shell(f"am start -a android.intent.action.VIEW -d '{PORTAL_URL}'", timeout=8)
    log(f"  intent → portal: {r.strip()[:80]}")

def portal_stats():
    try:
        import urllib.request
        with urllib.request.urlopen(BACKEND_STATS, timeout=4) as r:
            data = json.loads(r.read())
            by_dev = data.get("by_device", {}) if isinstance(data, dict) else {}
            log(f"  portal_stats: total_submits={data.get('total_submits','?')} devices={len(by_dev)}")
            for ip, st in list(by_dev.items())[:5]:
                log(f"    {ip}: {st}")
    except Exception as e:
        log(f"  portal_stats error: {e}")

def main():
    global CONNECTED
    cycle = 0
    log(f"=== phone_dispatcher start, log={LOG} ===")
    while True:
        cycle += 1
        log(f"--- cycle {cycle} ---")
        found = discover()
        if not found:
            log("mDNS: no _adb-tls-connect advertised. phone wifi-debug off or AP isolation. sleeping 30s.")
            time.sleep(30); continue
        ip, port = found
        log(f"mDNS: {ip}:{port}")
        ok, out = connect(ip, port)
        if not ok:
            log(f"connect failed: {out}")
            log("  → PAIRING REQUIRED. on phone: Developer Options → Wireless Debugging → 'Pair device with pairing code'")
            log("  → then run: scripts\\pair_phone.bat <pair_port> <6digit_code>")
            time.sleep(20); continue
        CONNECTED = (ip, port)
        log(f"connected. devices:\n{devices()}")

        snap = diag()
        for k, v in snap.items():
            log(f"  [{k}] {v.strip()[:200]}")

        force_cpd()  # no wifi kill — uses reevaluate + direct curl
        time.sleep(2)
        open_portal()
        time.sleep(3)
        portal_stats()

        log(f"cycle {cycle} done. sleeping {CYCLE_SEC}s")
        time.sleep(CYCLE_SEC)

if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        log("interrupted by user")
