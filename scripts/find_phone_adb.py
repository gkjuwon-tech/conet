"""Find Android wireless debug port. Android 11+ uses random port in high range."""
import socket, concurrent.futures as cf, time, sys

SUBNET = "192.168.0"
# LAN devices observed in arp; unknowns + known phone candidates
TARGETS = [13, 14, 15, 25, 26, 54]  # priority targets
ALL = list(range(1, 255))

def chk(args):
    ip, p = args
    s = socket.socket()
    s.settimeout(0.4)
    try:
        s.connect((ip, p))
        try:
            s.settimeout(0.3)
            b = s.recv(64)
        except Exception:
            b = b""
        s.close()
        return (ip, p, b[:32])
    except Exception:
        return None

def scan(ips, ports, workers=512):
    tasks = [(f"{SUBNET}.{i}", p) for i in ips for p in ports]
    print(f"[scan] {len(tasks)} probes...", flush=True)
    t0 = time.time()
    out = []
    with cf.ThreadPoolExecutor(max_workers=workers) as ex:
        for r in ex.map(chk, tasks):
            if r:
                out.append(r)
    print(f"[scan] done {time.time()-t0:.1f}s, hits={len(out)}", flush=True)
    return out

def main():
    # Phase 1: common ADB ports across full subnet
    common = [5555, 5037, 5554, 5556, 5558, 5560, 5562]
    hits = scan(ALL, common)
    for h in hits:
        print(" PH1", h, flush=True)

    # Phase 2: full high-port scan on priority candidates (Android 11+ random port)
    print("[scan] phase 2: high-port scan on priority IPs", flush=True)
    high = list(range(30000, 45000))  # mDNS adb-tls range commonly here
    hits2 = scan(TARGETS, high, workers=1024)
    for h in hits2:
        print(" PH2", h, flush=True)

    # Phase 3: even wider on candidates
    print("[scan] phase 3: wider scan 1024-65535 (sampled)", flush=True)
    wide = list(range(1024, 65536, 1))
    # full scan = 6*64512 = 387k, doable in chunks
    hits3 = []
    CHUNK = 20000
    for off in range(0, len(wide), CHUNK):
        sub = wide[off:off+CHUNK]
        h = scan(TARGETS, sub, workers=1024)
        hits3.extend(h)
        for x in h:
            print(" PH3", x, flush=True)
    print(f"\n=== SUMMARY ===\nphase1 {len(hits)}, phase2 {len(hits2)}, phase3 {len(hits3)}", flush=True)

if __name__ == "__main__":
    main()
