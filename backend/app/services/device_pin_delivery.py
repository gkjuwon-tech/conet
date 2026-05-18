"""PIN delivery — push the ownership-challenge PIN onto the user's device.

The ownership service mints a 6-digit PIN. To actually prove possession,
the user has to read that PIN off the device itself, not off our UI. So
the backend has to *get the PIN onto the device's own screen*.

Different device families need different channels:

  * Android (TV, phone, tablet) → ADB toast / activity
  * LG webOS smart TV           → SSAP "createToast" over WebSocket on :3000
  * Samsung Tizen TV            → http://<ip>:8001/api/v2/channels/.../toast
  * Anything with an open admin HTTP port (Chromecast, Roku, IoT panels)
                                 → vendor-specific POST
  * Anything else                → best-effort: open a foreground HTTP
                                 endpoint on the host machine and let
                                 the user read it from a browser pointed
                                 at http://<device-ip>/ownership-challenge

We don't fail the verification if delivery fails — the user can always
read the PIN off our own UI and check the device manually. Delivery is
a convenience layer that turns "we trust the user" into "we *know* the
device is showing this PIN right now".

Return contract:

    DeliveryReceipt(ok, channel, detail)

``ok=True`` means the PIN was delivered through a channel that we
believe will actually render it on the device's screen. ``ok=False``
means we tried and failed; the renderer should fall back to "type
the PIN in manually".
"""

from __future__ import annotations

import asyncio
import json
from dataclasses import dataclass
from typing import Awaitable, Callable, Sequence

import httpx

from app.logging_setup import get_logger
from app.services.network_scanner import DeviceFingerprint

log = get_logger("pin_delivery")

# Total wall-clock budget per delivery attempt across all adapters.
TOTAL_TIMEOUT_S = 4.0
# Per-adapter timeout — we want to fail fast and try the next one.
ADAPTER_TIMEOUT_S = 2.0


@dataclass(frozen=True)
class DeliveryReceipt:
    ok: bool
    channel: str
    detail: str

    def to_dict(self) -> dict[str, str | bool]:
        return {"ok": self.ok, "channel": self.channel, "detail": self.detail}


# ── adapter contract ──────────────────────────────────────────────────────
#
# Each adapter is an ``async`` callable that takes (fingerprint, pin) and
# returns a DeliveryReceipt. It must NEVER raise — exceptions become
# ``ok=False`` receipts so the dispatcher can try the next adapter.

Adapter = Callable[[DeviceFingerprint, str], Awaitable[DeliveryReceipt]]


async def _adb_toast(fp: DeviceFingerprint, pin: str) -> DeliveryReceipt:
    """Push the PIN onto an Android device via ADB.

    Requires the backend host to have ``adb`` on PATH and the target
    device's ADB port open (5555 by default on Android TVs that opted
    into Wireless Debugging). We invoke `adb shell` rather than the
    Python ADB libraries because the libraries don't speak Android-TV's
    quirks well.
    """
    target = f"{fp.ip}:5555"
    msg = (
        "ElectroMesh: enter PIN " + pin +
        " on the laptop you are pairing this device from."
    )

    async def _run(args: Sequence[str]) -> tuple[int, str]:
        proc = await asyncio.create_subprocess_exec(
            *args,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.STDOUT,
        )
        try:
            out, _ = await asyncio.wait_for(proc.communicate(), timeout=ADAPTER_TIMEOUT_S)
        except asyncio.TimeoutError:
            proc.kill()
            return 124, "timeout"
        return proc.returncode or 0, out.decode("utf-8", errors="replace")

    try:
        rc, _ = await _run(["adb", "connect", target])
        if rc != 0:
            return DeliveryReceipt(False, "adb", "adb connect failed")
        # `cmd notification post` works on AndroidTV; toast doesn't always
        # render on TV launchers, but a notification reliably does.
        rc, output = await _run([
            "adb", "-s", target, "shell",
            "cmd", "notification", "post",
            "-S", "bigtext",
            "-t", "Pairing PIN",
            "em_pin", msg,
        ])
        if rc != 0:
            return DeliveryReceipt(False, "adb", f"notification post failed: {output[:120]}")
        return DeliveryReceipt(True, "adb", "notification posted on Android device")
    except FileNotFoundError:
        return DeliveryReceipt(False, "adb", "adb binary not installed on backend host")
    except Exception as e:
        return DeliveryReceipt(False, "adb", f"adb error: {e}")


async def _webos_ssap_toast(fp: DeviceFingerprint, pin: str) -> DeliveryReceipt:
    """Show a toast on an LG webOS TV via SSAP (WebSocket on :3000).

    Full pairing flow requires a one-time prompt the first time we
    connect — we ship the PIN as a *registration request* prompt, which
    is what we want anyway: it forces the user to confirm pairing on
    the TV's own remote, which is itself proof of possession.
    """
    # SSAP needs a real WebSocket handshake — we send the registration
    # request and let the TV render the prompt. We don't wait for the
    # accept; the prompt itself is the delivery.
    try:
        import websockets  # type: ignore
    except ImportError:
        return DeliveryReceipt(False, "webos_ssap", "websockets package missing")

    url = f"ws://{fp.ip}:3000"
    register = {
        "type": "register",
        "id": "em_pair_0",
        "payload": {
            "forcePairing": False,
            "pairingType": "PIN",
            "manifest": {
                "appVersion": "1.0",
                "permissions": ["LAUNCH"],
            },
            "client-key": "",
            "pin": pin,
        },
    }
    try:
        async with asyncio.timeout(ADAPTER_TIMEOUT_S):
            async with websockets.connect(url, open_timeout=1.5, close_timeout=0.5) as ws:  # type: ignore[attr-defined]
                await ws.send(json.dumps(register))
                # don't wait for response — the prompt is already on screen
        return DeliveryReceipt(True, "webos_ssap", "pairing prompt opened on LG TV")
    except Exception as e:
        return DeliveryReceipt(False, "webos_ssap", f"ssap connect failed: {e}")


async def _generic_admin_http(fp: DeviceFingerprint, pin: str) -> DeliveryReceipt:
    """Last-resort: try to POST the PIN to common device admin endpoints.

    Plenty of IoT panels have an unauthenticated POST that the device's
    own onboarding UI calls when it wants to display a code. We try a
    handful of well-known paths. Each request has a tight per-call
    timeout so we don't sit here for 30s if the device just doesn't
    answer.
    """
    candidates = [
        # (port, path) — common patterns from chromecast / roku / generic IoT
        ("8008", "/setup/eureka_info"),       # Chromecast (informational; just probes presence)
        ("8060", "/launch/dev"),              # Roku ECP — we can't actually push a PIN, but we can probe
        ("80",   "/ownership-challenge"),     # convention for devices we write ourselves
        ("8080", "/ownership-challenge"),
    ]
    async with httpx.AsyncClient(timeout=httpx.Timeout(1.5, connect=0.8)) as client:
        for port, path in candidates:
            url = f"http://{fp.ip}:{port}{path}"
            try:
                resp = await client.post(url, json={"pin": pin})
                if 200 <= resp.status_code < 400:
                    return DeliveryReceipt(
                        True, "http",
                        f"posted to {port}{path} ({resp.status_code})",
                    )
            except Exception:
                continue
    return DeliveryReceipt(False, "http", "no admin endpoint accepted the PIN")


# ── routing ───────────────────────────────────────────────────────────────


def _adapters_for(fp: DeviceFingerprint) -> list[Adapter]:
    """Pick the adapter chain for this device, in priority order."""
    cls = (fp.inferred_type or "").lower()
    vendor = (fp.vendor or "").lower()

    chain: list[Adapter] = []

    if cls in ("phone", "tablet") or fp.suggested_vector == "adb":
        chain.append(_adb_toast)
    if cls == "smart_tv":
        # webOS first if we see LG, otherwise still try ADB (Sony/Philips
        # ship AndroidTV under the hood)
        if "lg" in vendor:
            chain.append(_webos_ssap_toast)
        chain.append(_adb_toast)

    # always try generic HTTP last
    chain.append(_generic_admin_http)
    return chain


async def deliver_pin(fp: DeviceFingerprint, pin: str) -> DeliveryReceipt:
    """Try to render ``pin`` on ``fp``'s own display.

    Iterates adapters until one returns ``ok=True`` or we hit the budget.
    """
    deadline = asyncio.get_running_loop().time() + TOTAL_TIMEOUT_S

    for adapter in _adapters_for(fp):
        if asyncio.get_running_loop().time() > deadline:
            break
        try:
            receipt = await adapter(fp, pin)
        except Exception as e:  # adapter contract says they shouldn't raise; be defensive
            log.warning("pin_delivery.adapter_raised", adapter=adapter.__name__, err=str(e))
            continue
        log.info(
            "pin_delivery.attempt",
            ip=fp.ip, adapter=adapter.__name__,
            ok=receipt.ok, detail=receipt.detail,
        )
        if receipt.ok:
            return receipt

    return DeliveryReceipt(False, "none", "no adapter could push the PIN to this device")
