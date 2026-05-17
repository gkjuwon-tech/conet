"""Built-in connectors for AdminGateway.

Each connector implements:
  *  ``matches(fp)``  — fingerprint-based pick rule
  *  ``approve(fp, portal_base_url)`` — actually push the device into
     a state where it will run our worker

Connector philosophy: **always use the vendor's official approved
control surface**, never injected or exploited.  When the official
surface requires a one-time physical OK (e.g. LG remote on first
pair), we surface that as ``bootstrap_action`` so the laptop UI can
walk the admin through it — but after that first time, the cached
credential makes every future operation zero-touch.
"""

from __future__ import annotations

import asyncio
import json
import os
import time
from pathlib import Path
from typing import Any

from app.logging_setup import get_logger
from app.services.admin_gateway.gateway import ApprovalResult, ApprovalStatus
from app.services.network_scanner import DeviceFingerprint

log = get_logger("gateway.connectors")


# ── LG webOS ────────────────────────────────────────────────────────

class LgWebosConnector:
    """SSAP register + cached client-key.

    First call needs ONE remote OK press (LG firmware enforced).
    Subsequent calls use the cached client-key for zero-touch launch.
    """
    name = "lg_webos"

    def matches(self, fp: DeviceFingerprint) -> bool:
        if fp.vendor.lower().startswith(("lg electronics",)):
            return True
        # Heuristic: SSAP port 3000 + LG-style port mix
        if 3000 in fp.open_ports and (1253 in fp.open_ports or 7000 in fp.open_ports):
            return True
        return False

    async def approve(
        self, fp: DeviceFingerprint, *, portal_base_url: str,
    ) -> ApprovalResult:
        # Reuse the existing production tv_launcher (proven flow)
        from app.services.tv_launcher import (
            launch_portal_background, _load_cache,
        )
        had_key = bool(_load_cache().get(fp.mac.lower()))
        r = await launch_portal_background(
            tv_ip=fp.ip,
            tv_mac=fp.mac,
            portal_url=f"{portal_base_url.rstrip('/')}/?bg=1",
        )
        if r.ok:
            return ApprovalResult(
                success=True,
                status=ApprovalStatus.cached if had_key else ApprovalStatus.approved,
                connector=self.name,
                bootstrap_needed=False,
                extra={"restored_to": r.restored_to, "had_cached_key": had_key},
            )
        # The most common failure mode is "first-time pair rejected"
        # (e.g. user pressed No or didn't reach the remote).
        return ApprovalResult(
            success=False,
            status=ApprovalStatus.needs_bootstrap,
            connector=self.name,
            bootstrap_needed=True,
            bootstrap_action="LG TV 화면의 'ElectroMesh 연결 허용' 팝업에서 리모컨 OK 한 번",
            bootstrap_timeout_s=60,
            error=r.error,
        )


# ── Roku (ECP — open standard, no auth) ─────────────────────────────

class RokuConnector:
    """Roku External Control Protocol — Roku's official LAN API.

    No auth required, no remote button, no cloud account.  Roku
    boxes are the friendliest of the bunch.
    """
    name = "roku_ecp"

    def matches(self, fp: DeviceFingerprint) -> bool:
        if "roku" in fp.vendor.lower():
            return True
        # Roku boxes usually advertise port 8060 (ECP) and 9080
        if 8060 in fp.open_ports:
            return True
        return False

    async def approve(
        self, fp: DeviceFingerprint, *, portal_base_url: str,
    ) -> ApprovalResult:
        # ECP "install" launch of the built-in Browser channel pointing to portal
        # Roku ECP: POST http://<ip>:8060/launch/<appId>?url=<portal>
        # Browser channel id varies; we ping device info first.
        try:
            reader, writer = await asyncio.wait_for(
                asyncio.open_connection(fp.ip, 8060), timeout=4,
            )
            url = f"{portal_base_url.rstrip('/')}/?bg=1"
            # Use launch with content URL parameter (Roku Browser channel = 31)
            req = (
                f"POST /launch/31?contentID={url} HTTP/1.1\r\n"
                f"Host: {fp.ip}:8060\r\n"
                f"Content-Length: 0\r\n\r\n"
            ).encode()
            writer.write(req); await writer.drain()
            data = await asyncio.wait_for(reader.read(256), timeout=4)
            writer.close(); await writer.wait_closed()
            head = data.decode("ascii", errors="replace")[:120]
            if "200" in head[:20]:
                return ApprovalResult(
                    success=True, status=ApprovalStatus.approved,
                    connector=self.name,
                    extra={"channel": "browser-31", "response": head},
                )
            return ApprovalResult(
                success=False, status=ApprovalStatus.failed,
                connector=self.name, error=f"ECP returned: {head}",
            )
        except Exception as e:
            return ApprovalResult(
                success=False, status=ApprovalStatus.failed,
                connector=self.name, error=f"ECP unreachable: {e}",
            )


# ── Chromecast / Google TV (DIAL) ────────────────────────────────────

class ChromecastConnector:
    """Chromecast via DIAL.

    DIAL is the open standard.  Default Cast app needs no cloud auth
    for *receiver lookup*.  Launching arbitrary URLs in a *Custom
    Receiver* normally requires a registered app ID with Google, but
    the official DIAL "Default Media Receiver" still accepts a load
    request for HTTP video / web content URLs from any LAN client.
    """
    name = "chromecast_dial"

    def matches(self, fp: DeviceFingerprint) -> bool:
        if "google" in fp.vendor.lower() or "chromecast" in fp.hostname.lower():
            return True
        if 8008 in fp.open_ports or 8009 in fp.open_ports:
            return True
        return False

    async def approve(
        self, fp: DeviceFingerprint, *, portal_base_url: str,
    ) -> ApprovalResult:
        url = f"{portal_base_url.rstrip('/')}/?bg=1"
        try:
            reader, writer = await asyncio.wait_for(
                asyncio.open_connection(fp.ip, 8008), timeout=4,
            )
            # DIAL: POST /apps/YouTube with v=URL is the conventional path,
            # but the truly portable approach is the Default Media Receiver
            # via Cast V2 socket on 8009 -- that needs protobuf, beyond the
            # scope of this connector.  For now we just verify reachability
            # so the queue marks Chromecasts as "ready, needs cast SDK push"
            # and we surface a bootstrap_action telling the laptop UI to use
            # the embedded Cast Sender JS instead.
            writer.write(
                f"GET /setup/eureka_info HTTP/1.1\r\nHost: {fp.ip}:8008\r\n\r\n"
                .encode()
            )
            await writer.drain()
            data = await asyncio.wait_for(reader.read(1024), timeout=4)
            writer.close(); await writer.wait_closed()
            ok = b"200" in data[:20]
            return ApprovalResult(
                success=ok,
                status=ApprovalStatus.needs_bootstrap if ok else ApprovalStatus.failed,
                connector=self.name,
                bootstrap_needed=ok,
                bootstrap_action=(
                    "노트북 UI의 'Cast' 버튼 한 번 — 구글 Cast SDK가 즉시 portal 송출"
                ),
                bootstrap_timeout_s=10,
                error="" if ok else "DIAL endpoint unresponsive",
                extra={"dial_url": f"http://{fp.ip}:8008/", "target": url},
            )
        except Exception as e:
            return ApprovalResult(
                success=False, status=ApprovalStatus.failed,
                connector=self.name, error=str(e),
            )


# ── BYOD phones / laptops (captive portal autopopup) ─────────────────

class CaptiveByodConnector:
    """Phones, laptops, anything with a real browser.

    There is no legitimate firmware path to install code on an
    unmanaged consumer phone without one user action.  The OS-standard
    zero-friction model is captive-portal autopopup — that's literally
    what every hotel/airport WiFi uses, and it's the model Apple/Google
    explicitly support.

    Our laptop's portal server handles the rest.  This connector just
    records that the device is "ready and waiting for its OS to surface
    the popup on next DHCP renewal / CPD probe."
    """
    name = "captive_byod"

    def matches(self, fp: DeviceFingerprint) -> bool:
        # Catch-all: anything not handled by a specialised connector
        # that has a browser-class form factor.
        if fp.inferred_type in (
            "phone", "tablet", "laptop", "desktop",
            "smart_tv",     # generic smart TVs with no SSAP-compatible vendor
            "stb",          # set-top boxes typically have a browser
            "unknown",      # last-resort fallback for browser-capable devices
        ):
            return True
        # Privacy-randomized MACs are almost certainly phones.
        first_octet = int(fp.mac.split(":")[0], 16) if fp.mac else 0
        if first_octet & 0x02:                     # locally administered bit
            return True
        # HTTP-capable devices generally have some web surface to attach to
        if 80 in fp.open_ports or 8080 in fp.open_ports:
            return True
        return False

    async def approve(
        self, fp: DeviceFingerprint, *, portal_base_url: str,
    ) -> ApprovalResult:
        # Nothing to push proactively — the device's OS does the work
        # when it next runs its CPD probe.  We tell the laptop UI what
        # the user can OPTIONALLY do to accelerate this.
        return ApprovalResult(
            success=True,
            status=ApprovalStatus.needs_bootstrap,
            connector=self.name,
            bootstrap_needed=True,
            bootstrap_action=(
                f"폰: 와이파이 토글 또는 브라우저에서 {portal_base_url} 접속 후 'start mining' 1탭. "
                f"이후 Service Worker로 영구 백그라운드 실행."
            ),
            bootstrap_timeout_s=0,         # waiting indefinitely
            extra={"portal_url": portal_base_url},
        )
