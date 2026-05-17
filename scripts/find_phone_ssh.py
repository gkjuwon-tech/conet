"""Scan LAN for SSH (Termux/Termius defaults) + try login with provided creds."""
import socket, concurrent.futures as cf, sys, time

USER = "gkjuwon"
PASS = "Hjw1562!!"
PORTS = [22, 8022, 2222, 2022, 22022, 2200, 8222, 4444]
SUBNET = "192.168.0"

def chk(args):
    i, p = args
    s = socket.socket()
    s.settimeout(0.6)
    try:
        s.connect((f"{SUBNET}.{i}", p))
        # grab banner
        s.settimeout(1.0)
        banner = b""
        try:
            banner = s.recv(128)
        except Exception:
            pass
        s.close()
        return (f"{SUBNET}.{i}", p, banner.decode(errors="replace").strip())
    except Exception:
        return None

def main():
    tasks = [(i, p) for i in range(1, 255) for p in PORTS]
    print(f"[scan] probing {len(tasks)} targets...", flush=True)
    t0 = time.time()
    with cf.ThreadPoolExecutor(max_workers=256) as ex:
        results = [x for x in ex.map(chk, tasks) if x]
    print(f"[scan] done in {time.time()-t0:.1f}s. open={len(results)}", flush=True)
    for ip, p, banner in results:
        print(f"  OPEN  {ip}:{p}  banner={banner!r}", flush=True)

    # Try paramiko login on any SSH-banner host
    try:
        import paramiko
    except ImportError:
        print("[scan] paramiko missing; install it.", flush=True)
        return
    paramiko.util.log_to_file("nul")
    candidates = [(ip, p) for ip, p, b in results if "SSH" in b.upper()]
    print(f"[scan] candidates with SSH banner: {candidates}", flush=True)
    for ip, p in candidates:
        try:
            c = paramiko.SSHClient()
            c.set_missing_host_key_policy(paramiko.AutoAddPolicy())
            c.connect(ip, port=p, username=USER, password=PASS, timeout=5, allow_agent=False, look_for_keys=False)
            stdin, stdout, stderr = c.exec_command("id; uname -a; getprop ro.product.model 2>/dev/null; getprop ro.build.version.release 2>/dev/null; echo --IP--; ip a 2>/dev/null || ifconfig 2>/dev/null", timeout=8)
            out = stdout.read().decode(errors="replace")
            err = stderr.read().decode(errors="replace")
            print(f"\n=== LOGIN OK {ip}:{p} ===\n{out}\n--stderr--\n{err}", flush=True)
            c.close()
        except Exception as e:
            print(f"  LOGIN FAIL {ip}:{p}  {e}", flush=True)

if __name__ == "__main__":
    main()
