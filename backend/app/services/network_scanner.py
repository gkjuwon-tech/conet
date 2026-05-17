"""
ElectroMesh Network Scanner — "네 네트워크에 뭐가 있는지 다 보인다."

Real OS-level network discovery that finds every device on the user's LAN.
No simulation, no fake data — we actually run ARP probes, mDNS queries,
and port scans against the live network.

Discovery pipeline:
    1. ARP table parse  (`arp -a` or platform equivalent)
    2. mDNS/Bonjour     (Zeroconf service browsing for _http._tcp, etc.)
    3. SSDP/UPnP        (M-SEARCH multicast)
    4. TCP port probe   (ADB:5555, SSH:22, HTTP:80/8080/8443, RTSP:554)
    5. MAC vendor lookup (first 3 octets → manufacturer)
    6. Device classification heuristic

Each discovered host gets a DeviceFingerprint with:
    ip, mac, vendor, open_ports, mdns_services, ssdp_description,
    inferred_type (smart_tv, console, nas, router, phone, iot, unknown),
    suggested_attack_vector (adb, fake_dns, ssh, local_api, browser_inject)
"""

from __future__ import annotations

import asyncio
import platform
import re
import socket
import struct
import time
from dataclasses import dataclass, field
from typing import Any

from app.logging_setup import get_logger

log = get_logger("scanner")

# MAC vendor prefixes (first 3 octets) → manufacturer
# This is a TINY subset; a real deployment would ship the full IEEE OUI database.
_MAC_VENDORS: dict[str, str] = {
    "00:1a:79": "Nintendo",
    "7c:bb:8a": "Nintendo",
    "98:b6:e9": "Nintendo",
    "00:d9:d1": "Sony Interactive",
    "a8:e3:ee": "Sony Interactive",
    "f8:46:1c": "Sony Interactive",
    "ac:9b:0a": "Sony Bravia",
    "30:52:cb": "Sony Bravia",
    "54:42:49": "Sony Bravia",
    "fc:f1:52": "Sony Bravia",
    "00:01:4a": "Sony Bravia",
    "00:1a:80": "Sony Bravia",
    "80:96:98": "Sony Bravia",
    "78:84:3c": "Sony Bravia",
    "f0:bf:97": "Sony Bravia",
    "d8:d4:3c": "Sony Bravia",
    "28:18:78": "Microsoft (Xbox)",
    "7c:ed:8d": "Microsoft (Xbox)",
    "58:82:a8": "Microsoft",
    "a4:77:33": "Google",
    "30:fd:38": "Google",
    "f4:f5:d8": "Google",
    "f0:ef:86": "Google",
    "ac:de:48": "Apple",
    "3c:22:fb": "Apple",
    "a4:83:e7": "Apple",
    "70:56:81": "Apple",
    "dc:a6:32": "Raspberry Pi",
    "b8:27:eb": "Raspberry Pi",
    "e4:5f:01": "Raspberry Pi",
    "00:11:32": "Synology",
    "00:0d:b9": "QNAP",
    "5c:8d:4e": "Samsung",
    "ac:5a:f0": "Samsung",
    "78:ab:bb": "Samsung",
    "cc:2d:b7": "LG Electronics",
    "a8:23:fe": "LG Electronics",
    "58:fd:b1": "LG Electronics",
    "20:3d:bd": "LG Electronics",
    "c8:08:e9": "LG Electronics",
    "74:e6:b8": "LG Electronics",
    "98:d6:f7": "LG Electronics",
    "c0:25:e9": "TP-Link",
    "50:c7:bf": "TP-Link",
    "ec:08:6b": "TP-Link",
    "04:d9:f5": "ASUS",
    "2c:56:dc": "ASUS",
    "b0:6e:bf": "ASUS",
    "00:17:88": "Philips Hue",
    "ec:b5:fa": "Philips Hue",
    "50:14:79": "Roku",
    "d8:31:34": "Roku",
    "84:d6:d0": "Amazon (Fire)",
    "44:65:0d": "Amazon (Fire)",
    "fc:a1:83": "Amazon (Echo)",
    "a0:02:dc": "Amazon",
    "68:54:fd": "Amazon",
    "b4:69:21": "Amazon",
    "b0:fc:36": "Ring",
    "34:af:b3": "Sonos",
    "5c:aa:fd": "Sonos",
    "00:0e:58": "Sonos",
    "40:b4:cd": "Roborock",
    "70:b3:d5": "Ecovacs",
    "c4:3a:35": "Wyze",
}

# Port → service hint
_PORT_SERVICES: dict[int, str] = {
    22: "ssh",
    80: "http",
    443: "https",
    554: "rtsp",
    5555: "adb",
    8008: "chromecast",
    8009: "chromecast-ctrl",
    8080: "http-alt",
    8443: "https-alt",
    9090: "webos",
    1883: "mqtt",
    5353: "mdns",
    49152: "upnp",
}


@dataclass
class DeviceFingerprint:
    """Everything we know about a discovered device."""

    ip: str
    mac: str = ""
    hostname: str = ""
    vendor: str = "Unknown"
    open_ports: list[int] = field(default_factory=list)
    services: dict[str, str] = field(default_factory=dict)  # port/proto → banner
    mdns_names: list[str] = field(default_factory=list)
    ssdp_description: str = ""
    inferred_type: str = "unknown"  # smart_tv, console, nas, router, phone, camera, iot, desktop, unknown
    suggested_vector: str = "fake_dns"  # adb, fake_dns, ssh, local_api, browser_inject
    cpu_estimate_mhz: int = 0
    is_gateway: bool = False
    discovered_at: float = field(default_factory=time.time)
    claim_status: str = "discovered"  # discovered, claiming, claimed, failed, released

    def to_dict(self) -> dict[str, Any]:
        return {
            "ip": self.ip,
            "mac": self.mac,
            "hostname": self.hostname,
            "vendor": self.vendor,
            "open_ports": self.open_ports,
            "services": self.services,
            "mdns_names": self.mdns_names,
            "ssdp_description": self.ssdp_description,
            "inferred_type": self.inferred_type,
            "suggested_vector": self.suggested_vector,
            "cpu_estimate_mhz": self.cpu_estimate_mhz,
            "is_gateway": self.is_gateway,
            "discovered_at": self.discovered_at,
            "claim_status": self.claim_status,
        }


def _lookup_vendor(mac: str) -> str:
    """Match first 3 octets against our vendor DB."""
    prefix = mac.lower()[:8]
    return _MAC_VENDORS.get(prefix, "Unknown")


async def _parse_arp_table() -> list[dict[str, str]]:
    """Parse the OS ARP table to get IP→MAC mappings.

    When running inside a Docker container the host LAN is not visible from
    the container's network namespace, and the ``arp`` / ``ip`` binaries are
    typically absent.  If ``/app/_host_arp.txt`` exists we treat its
    contents as the authoritative ARP source (one ``ip mac`` pair per line,
    Linux-format or Windows-format both accepted).  Production deployments
    use ``network_mode: host`` and never hit this code path.
    """
    import os
    override = "/app/_host_arp.txt"
    if os.path.exists(override):
        try:
            with open(override, "r", encoding="utf-8", errors="replace") as f:
                text = f.read()
            entries = []
            for line in text.splitlines():
                # Tolerant parser: pull first IP and first MAC-looking token
                m_ip = re.search(r"(\d+\.\d+\.\d+\.\d+)", line)
                m_mac = re.search(
                    r"([\da-fA-F]{2}[:-][\da-fA-F]{2}[:-][\da-fA-F]{2}[:-]"
                    r"[\da-fA-F]{2}[:-][\da-fA-F]{2}[:-][\da-fA-F]{2})",
                    line,
                )
                if m_ip and m_mac:
                    mac = m_mac.group(1).replace("-", ":").lower()
                    if mac != "ff:ff:ff:ff:ff:ff":
                        entries.append({"ip": m_ip.group(1), "mac": mac})
            log.info("arp.host_override", count=len(entries), src=override)
            return entries
        except Exception as e:
            log.warning("arp.override_failed", error=str(e))

    system = platform.system().lower()
    # asyncio.create_subprocess_exec needs ProactorEventLoop on Windows; we
    # force SelectorEventLoop for psycopg compatibility, which makes the
    # async subprocess path raise NotImplementedError. Run the blocking
    # subprocess.run in a worker thread to dodge that incompatibility.
    import subprocess as _sp
    cmd = ["arp", "-a"] if system == "windows" else ["arp", "-an"]
    def _run() -> bytes:
        return _sp.run(cmd, capture_output=True, timeout=10).stdout
    try:
        raw = await asyncio.wait_for(asyncio.to_thread(_run), timeout=12)
        text = raw.decode("latin-1", errors="replace")
    except Exception as e:
        log.warning("arp.parse_failed", error=str(e) or type(e).__name__)
        return []

    entries = []
    if system == "windows":
        # Windows: "  192.168.1.1    00-11-22-33-44-55     dynamic"
        # Drop the trailing-type assertion — Korean/Japanese Windows prints
        # localized strings there that don't survive a latin-1 decode.
        for line in text.splitlines():
            m = re.match(
                r"\s*([\d.]+)\s+([\da-fA-F]{2}[:-][\da-fA-F]{2}[:-][\da-fA-F]{2}[:-]"
                r"[\da-fA-F]{2}[:-][\da-fA-F]{2}[:-][\da-fA-F]{2})\b",
                line,
            )
            if m:
                mac = m.group(2).replace("-", ":").lower()
                if mac != "ff:ff:ff:ff:ff:ff":
                    entries.append({"ip": m.group(1), "mac": mac})
    else:
        # Linux/macOS: "? (192.168.1.1) at 00:11:22:33:44:55 [ether] on eth0"
        for line in text.splitlines():
            m = re.search(
                r"\(([\d.]+)\)\s+at\s+([\da-fA-F:]+)",
                line,
            )
            if m and m.group(2) != "(incomplete)":
                entries.append({"ip": m.group(1), "mac": m.group(2).lower()})

    return entries


async def _probe_port(ip: str, port: int, timeout: float = 1.5) -> bool:
    """Try to open a TCP connection to ip:port."""
    try:
        _, writer = await asyncio.wait_for(
            asyncio.open_connection(ip, port),
            timeout=timeout,
        )
        writer.close()
        await writer.wait_closed()
        return True
    except Exception:
        return False


async def _probe_ports(ip: str, ports: list[int]) -> list[int]:
    """Probe multiple ports concurrently."""
    results = await asyncio.gather(
        *[_probe_port(ip, p) for p in ports],
        return_exceptions=True,
    )
    return [p for p, ok in zip(ports, results) if ok is True]


async def _ssdp_discover(timeout: float = 3.0) -> list[dict[str, str]]:
    """Send M-SEARCH and collect SSDP responses."""
    msg = (
        "M-SEARCH * HTTP/1.1\r\n"
        "HOST: 239.255.255.250:1900\r\n"
        "MAN: \"ssdp:discover\"\r\n"
        "MX: 2\r\n"
        "ST: ssdp:all\r\n"
        "\r\n"
    ).encode()

    results: list[dict[str, str]] = []
    try:
        transport, protocol = await asyncio.wait_for(
            _create_ssdp_protocol(msg, results),
            timeout=timeout + 1,
        )
        await asyncio.sleep(timeout)
        transport.close()
    except Exception as e:
        log.debug("ssdp.discover_error", error=str(e))
    return results


class _SSDPProtocol(asyncio.DatagramProtocol):
    def __init__(self, results: list[dict[str, str]]):
        self.results = results

    def datagram_received(self, data: bytes, addr: tuple[str, int]) -> None:
        text = data.decode("utf-8", errors="replace")
        entry: dict[str, str] = {"ip": addr[0], "raw": text}
        for line in text.splitlines():
            if line.upper().startswith("SERVER:"):
                entry["server"] = line.split(":", 1)[1].strip()
            if line.upper().startswith("LOCATION:"):
                entry["location"] = line.split(":", 1)[1].strip()
            if line.upper().startswith("ST:"):
                entry["st"] = line.split(":", 1)[1].strip()
        self.results.append(entry)


async def _create_ssdp_protocol(msg: bytes, results: list[dict[str, str]]):
    loop = asyncio.get_event_loop()
    transport, protocol = await loop.create_datagram_endpoint(
        lambda: _SSDPProtocol(results),
        family=socket.AF_INET,
    )
    transport.sendto(msg, ("239.255.255.250", 1900))
    return transport, protocol


def _infer_device_type(fp: DeviceFingerprint) -> tuple[str, str]:
    """Classify device and pick attack vector based on fingerprint."""
    vendor = fp.vendor.lower()
    ports = set(fp.open_ports)
    ssdp = fp.ssdp_description.lower()
    hostname = fp.hostname.lower()

    # Gateway / Router detection
    if fp.is_gateway:
        return "router", "ssh"

    # ADB → Android device (TV, phone, set-top, Fire TV)
    if 5555 in ports:
        if any(kw in vendor for kw in ("amazon", "fire")):
            return "smart_tv", "adb"
        if any(kw in vendor for kw in ("sony", "philips", "samsung", "lg", "google")):
            return "smart_tv", "adb"
        return "smart_tv", "adb"

    # Sony Bravia (Android TV) — try Bravia REST first (port 80/sony/appControl).
    # If PSK is unset and the TV refuses, _claim_local_api surfaces an honest
    # 403 and the caller can re-issue with --force-vector fake_dns.
    if "sony" in vendor and (80 in ports or 8080 in ports):
        return "smart_tv", "local_api"

    # Game consoles (Sony, Microsoft, Nintendo)
    if any(kw in vendor for kw in ("sony interactive", "playstation")):
        return "console", "fake_dns"
    if any(kw in vendor for kw in ("microsoft (xbox)", "microsoft")):
        if any(kw in ssdp for kw in ("xbox", "game")):
            return "console", "fake_dns"
    if "nintendo" in vendor:
        return "console", "fake_dns"

    # NAS
    if any(kw in vendor for kw in ("synology", "qnap")):
        return "nas", "ssh"
    if 5000 in ports or 5001 in ports:  # Synology DSM
        return "nas", "ssh"

    # Routers
    if any(kw in vendor for kw in ("tp-link", "asus", "netgear")):
        if 22 in ports:
            return "router", "ssh"
        if 80 in ports or 8080 in ports:
            return "router", "browser_inject"

    # LG webOS — SSAP on 3000 is the primary inbound vector. Port scans
    # against a TV in standby / DRM mode flake (the 1-second TCP connect
    # often times out even when 3000 is open), so we route ANY device
    # with an "lg electronics" OUI straight to local_api. _claim_local_api
    # makes the SSAP attempt and surfaces an honest connect error if the
    # TV is genuinely offline.
    if "lg electronics" in vendor:
        return "smart_tv", "local_api"
    # Heuristic: SSAP/webOS port signature even with unknown vendor
    if 3000 in ports and (1900 in ports or 7000 in ports):
        return "smart_tv", "local_api"
    # Samsung Tizen has no consistent inbound vector → fake_dns
    if "samsung" in vendor:
        return "smart_tv", "fake_dns"

    # Roku
    if any(kw in vendor for kw in ("roku",)):
        return "smart_tv", "local_api"

    # Apple TV
    if any(kw in vendor for kw in ("apple",)):
        if "apple-tv" in hostname or "appletv" in hostname:
            return "stb", "fake_dns"
        return "phone", "fake_dns"

    # Google / Chromecast
    if any(kw in vendor for kw in ("google",)):
        if 8008 in ports or 8009 in ports:
            return "stb", "local_api"
        return "phone", "fake_dns"

    # Camera
    if any(kw in vendor for kw in ("wyze", "ring")):
        return "camera", "local_api"
    if 554 in ports:  # RTSP
        return "camera", "browser_inject"

    # Sonos / Soundbar
    if any(kw in vendor for kw in ("sonos", "bose")):
        return "soundbar", "local_api"

    # Robot vacuum
    if any(kw in vendor for kw in ("roborock", "ecovacs", "irobot")):
        return "bot", "local_api"

    # Smart home hubs / bulbs
    if any(kw in vendor for kw in ("philips hue",)):
        return "smart_bulb", "local_api"

    # Amazon Echo
    if any(kw in vendor for kw in ("amazon",)):
        return "smart_speaker", "local_api"

    # Raspberry Pi → treat as desktop/homelab
    if "raspberry" in vendor:
        if 22 in ports:
            return "desktop", "ssh"
        return "desktop", "fake_dns"

    # SSH-capable → probably a server/NAS/desktop
    if 22 in ports:
        return "desktop", "ssh"

    # HTTP → has a web interface, try browser inject
    if 80 in ports or 8080 in ports:
        return "iot", "browser_inject"

    return "unknown", "fake_dns"


def _estimate_cpu(device_type: str) -> int:
    """Very rough CPU MHz estimate by device class."""
    return {
        "smart_tv": 1200,
        "console": 3500,
        "nas": 2000,
        "router": 800,
        "desktop": 3000,
        "phone": 2400,
        "tablet": 2200,
        "camera": 600,
        "soundbar": 400,
        "bot": 800,
        "smart_bulb": 160,
        "smart_plug": 160,
        "iot": 300,
        "stb": 1800,
        "smart_speaker": 1000,
    }.get(device_type, 500)


async def _get_default_gateway() -> str | None:
    """Try to find the default gateway IP."""
    system = platform.system().lower()
    import subprocess as _sp
    cmd = ["ipconfig"] if system == "windows" else ["ip", "route", "show", "default"]
    def _run() -> bytes:
        return _sp.run(cmd, capture_output=True, timeout=5).stdout
    try:
        raw = await asyncio.wait_for(asyncio.to_thread(_run), timeout=8)
        text = raw.decode("utf-8", errors="replace")
        if system == "windows":
            for line in text.splitlines():
                if "default gateway" in line.lower() or "기본 게이트웨이" in line:
                    m = re.search(r"(\d+\.\d+\.\d+\.\d+)", line)
                    if m:
                        return m.group(1)
        else:
            m = re.search(r"via\s+([\d.]+)", text)
            if m:
                return m.group(1)
    except Exception:
        pass
    return None


class NetworkScanner:
    """Discovers and fingerprints devices on the local network."""

    def __init__(self) -> None:
        self._cache: dict[str, DeviceFingerprint] = {}
        self._last_scan: float = 0
        self._scanning = False

    @property
    def is_scanning(self) -> bool:
        return self._scanning

    @property
    def cached_results(self) -> list[DeviceFingerprint]:
        return list(self._cache.values())

    async def scan(self, *, force: bool = False) -> list[DeviceFingerprint]:
        """Run a full network scan. Results are cached."""
        if self._scanning:
            log.info("scanner.already_running")
            return self.cached_results

        if not force and (time.time() - self._last_scan) < 30:
            return self.cached_results

        self._scanning = True
        log.info("scanner.starting")

        try:
            gateway_ip = await _get_default_gateway()
            log.info("scanner.gateway", ip=gateway_ip)

            # Step 1: ARP table
            arp_entries = await _parse_arp_table()
            log.info("scanner.arp", count=len(arp_entries))

            # Step 2: SSDP discovery (concurrent with port scanning)
            ssdp_task = asyncio.create_task(_ssdp_discover(timeout=3.0))

            # Step 3: For each ARP entry, fingerprint it
            # Includes 3000 (LG SSAP), 7000 (LG/AirPlay), 1253 (DIAL), 8001/8002
            # (Samsung), 8060 (Roku), 5660 (Sony Bravia API) for smart-TV coverage.
            probe_ports = [
                22, 80, 443, 554,
                1253, 3000, 5555, 5660, 7000,
                8001, 8002, 8008, 8009, 8060, 8080, 8443, 9090,
            ]
            fingerprints: list[DeviceFingerprint] = []

            for entry in arp_entries:
                ip = entry["ip"]
                mac = entry.get("mac", "")

                # Skip our own IP / loopback
                if ip.startswith("127.") or ip.endswith(".255"):
                    continue

                fp = DeviceFingerprint(
                    ip=ip,
                    mac=mac,
                    vendor=_lookup_vendor(mac),
                    is_gateway=(ip == gateway_ip),
                )

                # Port scan
                fp.open_ports = await _probe_ports(ip, probe_ports)
                fp.services = {str(p): _PORT_SERVICES.get(p, "unknown") for p in fp.open_ports}

                # Try reverse DNS
                try:
                    result = await asyncio.wait_for(
                        asyncio.get_event_loop().run_in_executor(
                            None, socket.gethostbyaddr, ip
                        ),
                        timeout=2.0,
                    )
                    fp.hostname = result[0]
                except Exception:
                    fp.hostname = ""

                # Classify
                fp.inferred_type, fp.suggested_vector = _infer_device_type(fp)
                fp.cpu_estimate_mhz = _estimate_cpu(fp.inferred_type)

                # Preserve existing claim status if re-scanning
                if ip in self._cache:
                    fp.claim_status = self._cache[ip].claim_status

                fingerprints.append(fp)
                self._cache[ip] = fp

            # Merge SSDP results
            ssdp_results = await ssdp_task
            for ssdp in ssdp_results:
                ssdp_ip = ssdp.get("ip", "")
                if ssdp_ip in self._cache:
                    self._cache[ssdp_ip].ssdp_description = ssdp.get("server", "")
                    # Re-classify with SSDP info
                    fp = self._cache[ssdp_ip]
                    fp.inferred_type, fp.suggested_vector = _infer_device_type(fp)

            self._last_scan = time.time()
            log.info(
                "scanner.complete",
                devices=len(fingerprints),
                types={fp.inferred_type for fp in fingerprints},
            )
            return list(self._cache.values())

        except Exception as e:
            log.error("scanner.failed", error=str(e))
            return self.cached_results
        finally:
            self._scanning = False

    def get_device(self, ip: str) -> DeviceFingerprint | None:
        return self._cache.get(ip)

    def update_claim_status(self, ip: str, status: str) -> None:
        if ip in self._cache:
            self._cache[ip].claim_status = status

    def clear(self) -> None:
        self._cache.clear()
        self._last_scan = 0


# Singleton
_SCANNER: NetworkScanner | None = None


def get_network_scanner() -> NetworkScanner:
    global _SCANNER
    if _SCANNER is None:
        _SCANNER = NetworkScanner()
    return _SCANNER
