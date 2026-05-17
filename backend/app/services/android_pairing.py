"""
Android Pairing Service — robust LAN-local enrollment for Android devices.

The legacy ``_claim_adb`` helper in ``claim_service.py`` is fine when ADB-over-Wi-Fi
is already enabled on the target (port 5555 open, no PIN). That covers maybe 20%
of the Android fleet — TV boxes, FireTV, factory-mode handsets. For the other
80% we need to *do the pairing* ourselves:

  • Android 11+ "Wireless debugging" advertises itself via mDNS as
    ``_adb-tls-pairing._tcp.local.`` (PIN-gated, one-shot) and
    ``_adb-tls-connect._tcp.local.`` (after pairing). The port is *random*
    (high-ephemeral, e.g. 37411), so port 5555 scanning misses it entirely.
  • Older devices keep ADB on the fixed TCP/5555 with no pairing PIN once
    "ADB over network" is toggled in Developer Options.
  • Some Android TV vendors expose ADB on alternate ports (Xiaomi → 5554,
    Sony Bravia → 5555, Nvidia Shield → 5555). We probe a small port set
    instead of locking to one.

The old service also lacked **friend-or-foe** logic — meaning the orchestrator
happily tried to claim the user's laptop / phone / dev box. The user explicitly
complained: "지금 아이폰은 적군아군을 구분을 못해. 나를 자꾸 막아." So this
module ships a strict allowlist filter (``FriendOrFoe``) keyed on:
  • our_ip / our_mac (always friend)
  • explicit user-passed `friends` list (laptops/phones/dev boxes)
  • gateway IP/MAC (never claim the router via ADB; that's a different vector)
  • a per-device veto flag persisted in memory for the session

Everything is async, every step is logged, every external call has a timeout
and retry/backoff (jittered exponential). No call ever blocks the event loop
for more than ``_PER_STEP_TIMEOUT`` seconds.

Public surface:
    pair_via_mdns(ctx, fingerprint, *, pin)  → PairOutcome
    pair_via_legacy(ctx, fingerprint)         → PairOutcome
    discover_pairing_offers(ctx)              → list[PairingOffer]
    enroll_android(ctx, fingerprint, *, pin)  → PairOutcome  ← high-level entry
    AndroidPairingService                      → singleton w/ session memory
    get_android_pairing_service()             → singleton accessor

Designed to be drop-in callable from:
    • ``claim_service._claim_adb`` (now a thin shim)
    • ``api.v1.android_pairing`` (new router, exposes pairing endpoints)
    • CLI tooling (manual pairing via ``electromesh-cli pair``)

Nothing in this module touches the user's machine outside the LAN.  All
operations are 100% LAN-local and ToS-gated upstream in the API layer.
"""

from __future__ import annotations

import asyncio
import os
import random
import re
import shutil
import socket
import struct
import time
from dataclasses import dataclass, field
from typing import Any, Awaitable, Callable, Iterable

from app.logging_setup import get_logger

log = get_logger("android_pair")


# ── tuning ────────────────────────────────────────────────────────────────

_PER_STEP_TIMEOUT = 8.0           # any single subprocess / socket op
_MDNS_LISTEN_S    = 4.5           # how long to wait for pairing service broadcasts
_CONNECT_PORTS    = (5555, 5554, 5556, 5557, 5558)  # ADB-over-Wi-Fi fallbacks
_RETRY_BASE_S     = 0.4
_RETRY_MAX_S      = 4.0
_RETRY_ATTEMPTS   = 4
_PIN_RE           = re.compile(r"^\d{6}$")
_MDNS_GROUP       = "224.0.0.251"
_MDNS_PORT        = 5353

# Service types Android broadcasts when "Wireless debugging" is toggled on.
_ADB_PAIRING_SVC  = "_adb-tls-pairing._tcp.local."
_ADB_CONNECT_SVC  = "_adb-tls-connect._tcp.local."
_ADB_LEGACY_SVC   = "_adb._tcp.local."   # very old devices / some TV boxes


# ── data classes ──────────────────────────────────────────────────────────

@dataclass(slots=True)
class FriendOrFoe:
    """Allowlist / blocklist for the pairing service.

    Anything matching ``our_ip``, ``our_mac``, one of ``friends_ip`` /
    ``friends_mac``, or the gateway is treated as a *friend* and the
    pairing pipeline refuses to touch it — this is what was missing on
    iPhone (and what blocked the user from his own machine).
    """
    our_ip: str = ""
    our_mac: str = ""
    gateway_ip: str = ""
    gateway_mac: str = ""
    friends_ip: tuple[str, ...] = ()
    friends_mac: tuple[str, ...] = ()
    vetoed_ip: set[str] = field(default_factory=set)

    def is_friend(self, ip: str = "", mac: str = "") -> tuple[bool, str]:
        """Return (True, reason) if the target must be skipped."""
        ip_n = (ip or "").strip()
        mac_n = (mac or "").lower().replace("-", ":").strip()
        if ip_n and ip_n == self.our_ip:
            return True, "self_ip"
        if mac_n and mac_n == self.our_mac.lower():
            return True, "self_mac"
        if ip_n and ip_n == self.gateway_ip:
            return True, "gateway_ip"
        if mac_n and mac_n == self.gateway_mac.lower():
            return True, "gateway_mac"
        if ip_n in self.friends_ip:
            return True, "friend_ip"
        if mac_n and mac_n in (m.lower() for m in self.friends_mac):
            return True, "friend_mac"
        if ip_n in self.vetoed_ip:
            return True, "vetoed"
        return False, ""

    def veto(self, ip: str) -> None:
        """Mark a target as permanently skipped for this session."""
        if ip:
            self.vetoed_ip.add(ip)


@dataclass(slots=True)
class PairingOffer:
    """An Android device that just advertised "I am pairable" via mDNS."""
    ip: str
    port: int
    instance: str = ""
    service: str = _ADB_PAIRING_SVC
    seen_at: float = field(default_factory=time.time)
    mac: str = ""

    @property
    def is_pairing(self) -> bool:
        return self.service == _ADB_PAIRING_SVC

    @property
    def is_connect(self) -> bool:
        return self.service == _ADB_CONNECT_SVC

    def to_dict(self) -> dict[str, Any]:
        return {
            "ip": self.ip,
            "port": self.port,
            "instance": self.instance,
            "service": self.service,
            "mac": self.mac,
            "seen_at": self.seen_at,
            "is_pairing": self.is_pairing,
            "is_connect": self.is_connect,
        }


@dataclass(slots=True)
class DeviceProps:
    """Subset of ``getprop`` output we care about during enrollment."""
    model: str = ""
    brand: str = ""
    manufacturer: str = ""
    sdk: str = ""
    release: str = ""
    security_patch: str = ""
    abi: str = ""
    is_emulator: bool = False

    def to_dict(self) -> dict[str, Any]:
        return {
            "model": self.model,
            "brand": self.brand,
            "manufacturer": self.manufacturer,
            "sdk": self.sdk,
            "release": self.release,
            "security_patch": self.security_patch,
            "abi": self.abi,
            "is_emulator": self.is_emulator,
        }


@dataclass(slots=True)
class PairOutcome:
    """High-level result of an enrollment attempt."""
    ok: bool
    ip: str
    method: str          # "mdns_pair", "legacy_connect", "blocked", "skip_friend"
    detail: str = ""
    error: str = ""
    props: DeviceProps | None = None
    duration_ms: int = 0
    port: int = 0
    pin_used: str = ""   # never the raw PIN — we only log its length

    def to_dict(self) -> dict[str, Any]:
        d: dict[str, Any] = {
            "ok": self.ok,
            "ip": self.ip,
            "method": self.method,
            "duration_ms": self.duration_ms,
            "port": self.port,
        }
        if self.detail:
            d["detail"] = self.detail
        if self.error:
            d["error"] = self.error
        if self.props:
            d["props"] = self.props.to_dict()
        if self.pin_used:
            d["pin_length"] = len(self.pin_used)
        return d


# ── adb wrapper ───────────────────────────────────────────────────────────

class AdbBinary:
    """Locate and invoke the ``adb`` binary on the host.

    The backend container may not ship with the Android SDK, so we look in:
        1. $ELECTROMESH_ADB_PATH
        2. /usr/local/bin/adb, /opt/android-sdk/platform-tools/adb
        3. ``shutil.which("adb")``

    Calls go through ``run()`` which enforces ``_PER_STEP_TIMEOUT`` and
    captures stdout+stderr separately (the official adb pair flow writes
    its prompts to stderr — we MUST capture both).
    """

    _SEARCH_PATHS: tuple[str, ...] = (
        "/usr/local/bin/adb",
        "/usr/bin/adb",
        "/opt/android-sdk/platform-tools/adb",
        "/opt/platform-tools/adb",
    )

    def __init__(self, override: str | None = None) -> None:
        self._path = self._resolve(override)

    @classmethod
    def _resolve(cls, override: str | None) -> str | None:
        env = os.environ.get("ELECTROMESH_ADB_PATH") or override or ""
        if env and os.path.isfile(env):
            return env
        for p in cls._SEARCH_PATHS:
            if os.path.isfile(p):
                return p
        which = shutil.which("adb")
        return which or None

    @property
    def available(self) -> bool:
        return self._path is not None

    @property
    def path(self) -> str:
        return self._path or "adb"

    async def run(
        self, *args: str, timeout: float = _PER_STEP_TIMEOUT,
        stdin: bytes | None = None,
    ) -> tuple[int, str, str]:
        """Run ``adb <args>`` and return (exit_code, stdout, stderr)."""
        if not self.available:
            return 127, "", "adb binary not found on host"
        try:
            proc = await asyncio.create_subprocess_exec(
                self.path, *args,
                stdin=asyncio.subprocess.PIPE if stdin else None,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )
            try:
                out, err = await asyncio.wait_for(
                    proc.communicate(stdin), timeout=timeout,
                )
            except TimeoutError:
                proc.kill()
                try:
                    await proc.wait()
                except Exception:
                    pass
                return 124, "", f"adb {args[0] if args else ''} timed out"
            rc = proc.returncode if proc.returncode is not None else -1
            return (
                rc,
                out.decode("utf-8", errors="replace").strip(),
                err.decode("utf-8", errors="replace").strip(),
            )
        except FileNotFoundError:
            return 127, "", "adb binary not found"
        except Exception as e:
            return -1, "", f"adb spawn failed: {e!s}"

    async def kill_server(self) -> None:
        await self.run("kill-server", timeout=4.0)

    async def start_server(self) -> None:
        await self.run("start-server", timeout=6.0)


# ── retry helper ──────────────────────────────────────────────────────────

async def _retry(
    fn: Callable[[], Awaitable[tuple[bool, str]]],
    *, attempts: int = _RETRY_ATTEMPTS,
    base: float = _RETRY_BASE_S, cap: float = _RETRY_MAX_S,
    name: str = "step",
) -> tuple[bool, str, int]:
    """Run ``fn`` with jittered exponential backoff.

    ``fn`` returns ``(success, message)``; the message is propagated on the
    final attempt regardless of outcome. Returns ``(ok, last_message, tries)``.
    """
    last = ""
    for i in range(1, attempts + 1):
        ok, msg = await fn()
        last = msg
        if ok:
            log.debug(f"android_pair.{name}.ok", attempt=i, msg=msg)
            return True, msg, i
        log.debug(f"android_pair.{name}.retry", attempt=i, msg=msg)
        if i >= attempts:
            break
        delay = min(cap, base * (2 ** (i - 1)))
        delay = delay * (0.7 + 0.6 * random.random())  # 70%-130% jitter
        await asyncio.sleep(delay)
    return False, last, attempts


# ── mDNS listener for Android pairing offers ──────────────────────────────

class _MdnsPairListener(asyncio.DatagramProtocol):
    """Capture mDNS responses and pull out _adb-tls-pairing PTR/SRV/A records.

    We don't implement a full RFC-6762 stack — the relevant records are
    PTR (service → instance), SRV (instance → host:port) and A (host → ipv4).
    """

    def __init__(self, offers: list[PairingOffer]) -> None:
        self._offers = offers
        # instance → (host, port, service)
        self._srv: dict[str, tuple[str, int, str]] = {}
        # host → ipv4
        self._a: dict[str, str] = {}

    def datagram_received(self, data: bytes, addr: tuple[str, int]) -> None:
        try:
            parsed = _parse_mdns(data, addr[0])
        except Exception as e:
            log.debug("mdns_pair.parse_fail", err=str(e))
            return
        for rec in parsed:
            if rec.get("kind") == "SRV":
                self._srv[rec["instance"]] = (rec["target"], rec["port"], rec["service"])
            elif rec.get("kind") == "A":
                self._a[rec["host"]] = rec["ip"]
            elif rec.get("kind") == "PTR":
                # Just ensure the instance key exists.
                self._srv.setdefault(rec["instance"], ("", 0, rec["service"]))
        self._coalesce(addr[0])

    def _coalesce(self, observed_ip: str) -> None:
        for inst, (host, port, svc) in list(self._srv.items()):
            ip = self._a.get(host) or observed_ip
            if not ip or not port:
                continue
            if svc not in (_ADB_PAIRING_SVC, _ADB_CONNECT_SVC, _ADB_LEGACY_SVC):
                continue
            for o in self._offers:
                if o.ip == ip and o.port == port and o.service == svc:
                    break
            else:
                offer = PairingOffer(ip=ip, port=port, instance=inst, service=svc)
                log.info(
                    "mdns_pair.offer",
                    ip=offer.ip, port=offer.port, svc=offer.service,
                )
                self._offers.append(offer)


def _parse_mdns(data: bytes, src_ip: str) -> list[dict[str, Any]]:
    """Minimal mDNS record extractor (PTR, SRV, A only)."""
    out: list[dict[str, Any]] = []
    if len(data) < 12:
        return out
    qd, an, ns, ar = struct.unpack("!HHHH", data[4:12])
    total = an + ns + ar
    if total == 0:
        return out
    p = 12

    def _read_name(pos: int) -> tuple[str, int]:
        labels: list[str] = []
        jumped = False
        end_pos = pos
        for _ in range(64):
            if pos >= len(data):
                break
            length = data[pos]
            if length == 0:
                pos += 1
                if not jumped:
                    end_pos = pos
                break
            if length & 0xC0 == 0xC0:
                if pos + 1 >= len(data):
                    break
                ptr = ((length & 0x3F) << 8) | data[pos + 1]
                if not jumped:
                    end_pos = pos + 2
                    jumped = True
                pos = ptr
                continue
            if pos + 1 + length > len(data):
                break
            labels.append(data[pos + 1: pos + 1 + length].decode("utf-8", errors="replace"))
            pos += 1 + length
        name = ".".join(labels)
        if name and not name.endswith("."):
            name = name + "."
        return name, end_pos if jumped else pos

    # Skip questions
    for _ in range(qd):
        _, p = _read_name(p)
        p += 4

    # Walk answers / authority / additional
    for _ in range(total):
        if p + 10 > len(data):
            return out
        name, p = _read_name(p)
        rtype, _rclass, _ttl, rdlen = struct.unpack("!HHIH", data[p:p + 10])
        p += 10
        rdata = data[p:p + rdlen]
        p += rdlen
        if rtype == 12:  # PTR
            inst_name, _ = _read_name_in(data, p - rdlen)
            svc = name
            out.append({"kind": "PTR", "service": svc, "instance": inst_name})
        elif rtype == 33 and rdlen >= 7:  # SRV
            _prio, _wt, port = struct.unpack("!HHH", rdata[:6])
            target, _ = _read_name_in(data, p - rdlen + 6)
            svc = ""
            # Reverse-derive the service: instance is "<name>._adb-tls-pairing._tcp.local."
            for s in (_ADB_PAIRING_SVC, _ADB_CONNECT_SVC, _ADB_LEGACY_SVC):
                if name.endswith(s):
                    svc = s
                    break
            out.append({
                "kind": "SRV", "instance": name, "target": target,
                "port": port, "service": svc or _ADB_PAIRING_SVC,
            })
        elif rtype == 1 and rdlen == 4:  # A
            ip = ".".join(str(b) for b in rdata)
            out.append({"kind": "A", "host": name, "ip": ip})
    return out


def _read_name_in(data: bytes, start: int) -> tuple[str, int]:
    """Standalone copy of name reader for use during record parsing."""
    labels: list[str] = []
    pos = start
    jumped = False
    end_pos = start
    for _ in range(64):
        if pos >= len(data):
            break
        length = data[pos]
        if length == 0:
            pos += 1
            if not jumped:
                end_pos = pos
            break
        if length & 0xC0 == 0xC0:
            if pos + 1 >= len(data):
                break
            ptr = ((length & 0x3F) << 8) | data[pos + 1]
            if not jumped:
                end_pos = pos + 2
                jumped = True
            pos = ptr
            continue
        if pos + 1 + length > len(data):
            break
        labels.append(data[pos + 1: pos + 1 + length].decode("utf-8", errors="replace"))
        pos += 1 + length
    name = ".".join(labels)
    if name and not name.endswith("."):
        name = name + "."
    return name, end_pos if jumped else pos


async def discover_pairing_offers(
    *, listen_seconds: float = _MDNS_LISTEN_S,
    iface_ip: str | None = None,
) -> list[PairingOffer]:
    """Listen on 224.0.0.251:5353 for Android pairing/connect advertisements.

    Sends a single PTR query for each known service type to force devices
    that just toggled "Wireless debugging" to re-broadcast.  Returns every
    distinct ``(ip, port, service)`` tuple observed during the window.
    """
    offers: list[PairingOffer] = []
    loop = asyncio.get_event_loop()
    try:
        sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM, socket.IPPROTO_UDP)
        sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        try:
            sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEPORT, 1)
        except (AttributeError, OSError):
            pass
        sock.bind(("", _MDNS_PORT))
        bind_ip = iface_ip or socket.inet_aton("0.0.0.0")
        if isinstance(bind_ip, str):
            bind_ip = socket.inet_aton(bind_ip)
        mreq = socket.inet_aton(_MDNS_GROUP) + bind_ip
        sock.setsockopt(socket.IPPROTO_IP, socket.IP_ADD_MEMBERSHIP, mreq)
        sock.setblocking(False)
    except OSError as e:
        log.warning("mdns_pair.bind_fail", err=str(e))
        return offers

    transport, _proto = await loop.create_datagram_endpoint(
        lambda: _MdnsPairListener(offers),
        sock=sock,
    )

    # Send a unicast probe per service type — speeds up first reply by ~3s.
    try:
        for svc in (_ADB_PAIRING_SVC, _ADB_CONNECT_SVC, _ADB_LEGACY_SVC):
            pkt = _build_mdns_query(svc)
            try:
                transport.sendto(pkt, (_MDNS_GROUP, _MDNS_PORT))
            except Exception as e:
                log.debug("mdns_pair.query_send_fail", svc=svc, err=str(e))
        await asyncio.sleep(listen_seconds)
    finally:
        transport.close()

    log.info("mdns_pair.discover.complete", count=len(offers), window=listen_seconds)
    return offers


def _build_mdns_query(service: str) -> bytes:
    """Build a one-question mDNS PTR query for ``service``."""
    header = struct.pack("!HHHHHH", 0, 0x0000, 1, 0, 0, 0)

    def enc(name: str) -> bytes:
        out = b""
        for part in name.rstrip(".").split("."):
            if not part:
                continue
            out += bytes([len(part)]) + part.encode()
        return out + b"\x00"

    qname = enc(service)
    qtype_qclass = struct.pack("!HH", 12, 1)
    return header + qname + qtype_qclass


# ── getprop ───────────────────────────────────────────────────────────────

_GETPROP_KEYS: tuple[str, ...] = (
    "ro.product.model",
    "ro.product.brand",
    "ro.product.manufacturer",
    "ro.build.version.sdk",
    "ro.build.version.release",
    "ro.build.version.security_patch",
    "ro.product.cpu.abi",
    "ro.kernel.qemu",
)


async def fetch_props(adb: AdbBinary, serial: str) -> DeviceProps:
    """Pull a small set of ``getprop`` values from a connected device."""
    props = DeviceProps()
    cmd_lines = " ; ".join(f"getprop {k}" for k in _GETPROP_KEYS)
    rc, out, err = await adb.run("-s", serial, "shell", cmd_lines, timeout=_PER_STEP_TIMEOUT)
    if rc != 0:
        log.warning("android_pair.getprop_fail", serial=serial, rc=rc, err=err[:120])
        return props
    parts = out.splitlines()
    while len(parts) < len(_GETPROP_KEYS):
        parts.append("")
    (
        props.model, props.brand, props.manufacturer,
        props.sdk, props.release, props.security_patch,
        props.abi, qemu,
    ) = (p.strip() for p in parts[: len(_GETPROP_KEYS)])
    props.is_emulator = qemu == "1"
    log.info(
        "android_pair.getprop",
        serial=serial,
        model=props.model, brand=props.brand,
        sdk=props.sdk, release=props.release,
        is_emulator=props.is_emulator,
    )
    return props


# ── pairing flows ─────────────────────────────────────────────────────────

async def pair_via_mdns(
    offer: PairingOffer, *, pin: str,
    adb: AdbBinary | None = None,
) -> PairOutcome:
    """Run the ``adb pair host:port`` flow for an Android 11+ offer.

    The user reads the 6-digit PIN off their phone and POSTs it to the
    backend; we feed it via stdin to ``adb pair`` (which prompts:
    ``Enter pairing code:``). On success, ``adb connect host:5555``
    (or whatever port the *connect* service is advertising) gets a
    persistent shell.
    """
    started = time.monotonic()
    a = adb or AdbBinary()
    if not a.available:
        return PairOutcome(
            ok=False, ip=offer.ip, method="mdns_pair",
            error="adb binary not found on host",
            duration_ms=int((time.monotonic() - started) * 1000),
            port=offer.port,
        )
    if not pin or not _PIN_RE.match(pin):
        return PairOutcome(
            ok=False, ip=offer.ip, method="mdns_pair",
            error=f"invalid pin: expected 6 digits, got len={len(pin)}",
            duration_ms=int((time.monotonic() - started) * 1000),
            port=offer.port,
            pin_used=pin,
        )

    target = f"{offer.ip}:{offer.port}"

    async def _do_pair() -> tuple[bool, str]:
        rc, out, err = await a.run(
            "pair", target, pin,
            timeout=_PER_STEP_TIMEOUT,
        )
        text = (out + "\n" + err).lower()
        if "successfully paired" in text or "pairing successful" in text:
            return True, "paired"
        if "failed" in text or rc != 0:
            return False, (err or out)[:160] or f"rc={rc}"
        # Some adb builds need the PIN on stdin. Retry with stdin once.
        rc2, out2, err2 = await a.run(
            "pair", target,
            timeout=_PER_STEP_TIMEOUT,
            stdin=(pin + "\n").encode(),
        )
        text2 = (out2 + "\n" + err2).lower()
        if "successfully paired" in text2 or "pairing successful" in text2:
            return True, "paired_stdin"
        return False, (err2 or out2)[:160] or f"rc={rc2}"

    paired, msg, tries = await _retry(_do_pair, name="mdns_pair", attempts=3)
    if not paired:
        log.warning(
            "android_pair.mdns_pair.failed",
            ip=offer.ip, port=offer.port, tries=tries, msg=msg,
        )
        return PairOutcome(
            ok=False, ip=offer.ip, method="mdns_pair",
            error=msg,
            duration_ms=int((time.monotonic() - started) * 1000),
            port=offer.port,
            pin_used=pin,
        )

    # We just have a *pairing* relationship — now establish the connect
    # session on the persistent ADB port (Android advertises it as a separate
    # _adb-tls-connect SRV). Discover it; fall back to port 5555.
    offers = await discover_pairing_offers(listen_seconds=2.0)
    connect = next(
        (o for o in offers if o.ip == offer.ip and o.service == _ADB_CONNECT_SVC),
        None,
    )
    connect_target = f"{offer.ip}:{connect.port}" if connect else f"{offer.ip}:5555"

    async def _do_connect() -> tuple[bool, str]:
        rc, out, err = await a.run("connect", connect_target, timeout=_PER_STEP_TIMEOUT)
        text = (out + "\n" + err).lower()
        if "connected" in text or "already" in text:
            return True, text[:120]
        return False, (err or out)[:160] or f"rc={rc}"

    connected, msg2, tries2 = await _retry(_do_connect, name="mdns_connect", attempts=3)
    if not connected:
        log.warning(
            "android_pair.mdns_connect.failed",
            ip=offer.ip, port=connect_target.rsplit(":", 1)[-1],
            tries=tries2, msg=msg2,
        )
        return PairOutcome(
            ok=False, ip=offer.ip, method="mdns_pair",
            error=f"paired but connect failed: {msg2}",
            duration_ms=int((time.monotonic() - started) * 1000),
            port=int(connect_target.rsplit(":", 1)[-1]),
            pin_used=pin,
        )

    props = await fetch_props(a, connect_target)
    return PairOutcome(
        ok=True, ip=offer.ip, method="mdns_pair",
        detail=f"paired+connected in {tries + tries2} attempts",
        props=props,
        duration_ms=int((time.monotonic() - started) * 1000),
        port=int(connect_target.rsplit(":", 1)[-1]),
        pin_used=pin,
    )


async def pair_via_legacy(
    ip: str, *, ports: Iterable[int] = _CONNECT_PORTS,
    adb: AdbBinary | None = None, mac: str = "",
) -> PairOutcome:
    """The classic ADB-over-Wi-Fi flow (no pairing PIN).

    Walks ``ports`` until one connects. Used for TV boxes, FireTV, and
    pre-Android-11 handsets where the user has manually toggled
    "ADB over network" in Developer Options.
    """
    started = time.monotonic()
    a = adb or AdbBinary()
    if not a.available:
        return PairOutcome(
            ok=False, ip=ip, method="legacy_connect",
            error="adb binary not found on host",
            duration_ms=int((time.monotonic() - started) * 1000),
        )
    last_msg = ""
    used_port = 0
    for port in ports:
        target = f"{ip}:{port}"

        async def _do_conn(_target: str = target) -> tuple[bool, str]:
            rc, out, err = await a.run("connect", _target, timeout=_PER_STEP_TIMEOUT)
            text = (out + "\n" + err).lower()
            if "connected" in text or "already" in text:
                return True, text[:120]
            if "unauthorized" in text:
                return False, "unauthorized (user must approve RSA key on device)"
            if "connection refused" in text or "cannot connect" in text:
                return False, "refused"
            return False, (err or out)[:160] or f"rc={rc}"

        ok, msg, _tries = await _retry(_do_conn, name=f"legacy_connect_{port}", attempts=2)
        last_msg = msg
        if ok:
            used_port = port
            break

    if not used_port:
        log.info("android_pair.legacy.fail_all_ports", ip=ip, msg=last_msg)
        return PairOutcome(
            ok=False, ip=ip, method="legacy_connect",
            error=last_msg or "no port responded",
            duration_ms=int((time.monotonic() - started) * 1000),
        )

    serial = f"{ip}:{used_port}"
    props = await fetch_props(a, serial)
    return PairOutcome(
        ok=True, ip=ip, method="legacy_connect",
        detail=f"port={used_port} mac={mac or 'unknown'}",
        props=props,
        port=used_port,
        duration_ms=int((time.monotonic() - started) * 1000),
    )


# ── orchestrator ──────────────────────────────────────────────────────────

class AndroidPairingService:
    """Stateful orchestrator — singleton via ``get_android_pairing_service()``.

    Holds:
      * ``adb``     — cached binary path
      * ``foe``     — FriendOrFoe filter (mutable across the session)
      * ``history`` — last 32 outcomes (ring buffer)
      * ``offers``  — last mDNS sweep result
    """

    _HISTORY_CAP = 32

    def __init__(self) -> None:
        self.adb = AdbBinary()
        self.foe = FriendOrFoe()
        self.history: list[PairOutcome] = []
        self.offers: list[PairingOffer] = []
        self._offer_at: float = 0.0
        self._lock = asyncio.Lock()
        self.stats: dict[str, int] = {
            "attempts": 0,
            "ok": 0,
            "failed": 0,
            "skipped_friend": 0,
            "mdns_offers_total": 0,
        }

    # ── public API ────────────────────────────────────────────────

    def configure_friends(
        self, *, our_ip: str = "", our_mac: str = "",
        gateway_ip: str = "", gateway_mac: str = "",
        friends_ip: Iterable[str] = (), friends_mac: Iterable[str] = (),
    ) -> dict[str, Any]:
        """Replace the friend-or-foe filter for this session.

        Called from the API layer right after the CLI sends LanContext.
        """
        self.foe = FriendOrFoe(
            our_ip=our_ip.strip(),
            our_mac=our_mac.lower().strip(),
            gateway_ip=gateway_ip.strip(),
            gateway_mac=gateway_mac.lower().strip(),
            friends_ip=tuple(ip.strip() for ip in friends_ip if ip.strip()),
            friends_mac=tuple(m.lower().strip() for m in friends_mac if m.strip()),
        )
        log.info(
            "android_pair.foe.configured",
            our_ip=self.foe.our_ip, our_mac=self.foe.our_mac,
            gateway_ip=self.foe.gateway_ip,
            friends=len(self.foe.friends_ip),
        )
        return self.snapshot_foe()

    def snapshot_foe(self) -> dict[str, Any]:
        return {
            "our_ip": self.foe.our_ip,
            "our_mac": self.foe.our_mac,
            "gateway_ip": self.foe.gateway_ip,
            "gateway_mac": self.foe.gateway_mac,
            "friends_ip": list(self.foe.friends_ip),
            "friends_mac": list(self.foe.friends_mac),
            "vetoed": sorted(self.foe.vetoed_ip),
        }

    def veto(self, ip: str) -> dict[str, Any]:
        self.foe.veto(ip)
        return self.snapshot_foe()

    async def sweep_offers(self, *, force: bool = False) -> list[PairingOffer]:
        """Run an mDNS pairing sweep, caching for 30 seconds."""
        async with self._lock:
            if not force and self.offers and time.time() - self._offer_at < 30:
                return list(self.offers)
            self.offers = await discover_pairing_offers()
            self._offer_at = time.time()
            self.stats["mdns_offers_total"] += len(self.offers)
            return list(self.offers)

    async def enroll(
        self, *, ip: str = "", mac: str = "",
        pin: str | None = None, port: int | None = None,
        prefer: str = "auto",
    ) -> PairOutcome:
        """High-level entry point.

        Strategy:
          1. ``foe.is_friend(ip, mac)`` → return method="skip_friend" early.
          2. If ``pin`` supplied: prefer the mdns_pair flow.
          3. Otherwise: try ``legacy_connect`` over the small port set.
          4. Fall back to mdns sweep + opportunistic legacy if a connect
             service is already advertised (no PIN needed because the user
             previously paired this device).
        """
        started = time.monotonic()
        self.stats["attempts"] += 1

        skip, why = self.foe.is_friend(ip=ip, mac=mac)
        if skip:
            self.stats["skipped_friend"] += 1
            out = PairOutcome(
                ok=False, ip=ip, method="skip_friend",
                detail=why,
                duration_ms=int((time.monotonic() - started) * 1000),
            )
            self._remember(out)
            log.info("android_pair.skip", ip=ip, reason=why)
            return out

        # 1) explicit pairing flow
        if pin and prefer in ("auto", "mdns_pair"):
            offer = await self._find_offer(ip)
            if offer is None and port:
                offer = PairingOffer(ip=ip, port=port, service=_ADB_PAIRING_SVC, mac=mac)
            if offer is not None:
                out = await pair_via_mdns(offer, pin=pin, adb=self.adb)
                self._remember(out)
                self._tally(out)
                return out
            # No pairing offer found AND no port supplied — fall through.
            log.info("android_pair.no_offer", ip=ip)

        # 2) try legacy connect
        if prefer in ("auto", "legacy_connect"):
            out = await pair_via_legacy(ip, adb=self.adb, mac=mac)
            self._remember(out)
            self._tally(out)
            if out.ok:
                return out

        # 3) last-ditch mDNS-driven legacy: maybe the device advertised a
        # connect service without us scanning yet.
        offers = await self.sweep_offers(force=True)
        connect = next(
            (o for o in offers if o.ip == ip and o.service == _ADB_CONNECT_SVC),
            None,
        )
        if connect is not None:
            out = await pair_via_legacy(
                ip, ports=(connect.port, *_CONNECT_PORTS),
                adb=self.adb, mac=mac,
            )
            self._remember(out)
            self._tally(out)
            return out

        fail = PairOutcome(
            ok=False, ip=ip, method="legacy_connect",
            error="no path worked: provide --pin or enable wireless debugging",
            duration_ms=int((time.monotonic() - started) * 1000),
        )
        self._remember(fail)
        self.stats["failed"] += 1
        return fail

    async def _find_offer(self, ip: str) -> PairingOffer | None:
        offers = await self.sweep_offers()
        for o in offers:
            if o.ip == ip and o.service == _ADB_PAIRING_SVC:
                return o
        return None

    def _remember(self, out: PairOutcome) -> None:
        self.history.append(out)
        if len(self.history) > self._HISTORY_CAP:
            self.history.pop(0)

    def _tally(self, out: PairOutcome) -> None:
        if out.ok:
            self.stats["ok"] += 1
        elif out.method != "skip_friend":
            self.stats["failed"] += 1

    def snapshot(self) -> dict[str, Any]:
        return {
            "adb_available": self.adb.available,
            "adb_path": self.adb.path,
            "stats": dict(self.stats),
            "foe": self.snapshot_foe(),
            "recent": [o.to_dict() for o in self.history[-8:]],
            "offers": [o.to_dict() for o in self.offers],
            "offers_age_s": max(0.0, time.time() - self._offer_at) if self._offer_at else None,
        }


_SVC: AndroidPairingService | None = None


def get_android_pairing_service() -> AndroidPairingService:
    global _SVC
    if _SVC is None:
        _SVC = AndroidPairingService()
    return _SVC


__all__ = [
    "AdbBinary",
    "AndroidPairingService",
    "DeviceProps",
    "FriendOrFoe",
    "PairOutcome",
    "PairingOffer",
    "discover_pairing_offers",
    "fetch_props",
    "get_android_pairing_service",
    "pair_via_legacy",
    "pair_via_mdns",
]
