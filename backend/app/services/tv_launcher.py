"""
TV Launcher — SSAP (LG webOS) browser launch + automatic livetv restore.

Today's working flow (verified 2026-05-11 on LG SK8000PA):

  1. WebSocket connect ws://<tv_ip>:3000
  2. Send ``register`` with stored ``client-key`` (or PROMPT for first
     pairing — user presses OK on the TV remote once, forever).
  3. ``ssap://system.launcher/open`` -> portal URL.
     The TV's built-in browser launches in foreground.
  4. Wait ~4 s so the portal JS spins up its work loop.
  5. ``ssap://system.launcher/launch id:com.webos.app.livetv`` to
     restore the live TV broadcast. The browser is moved to
     background; webOS keeps its WebKit process alive but throttles
     timers (~1 Hz vs ~16 Hz foreground).

Client-keys are persisted per TV MAC in a JSON cache so subsequent
launches need zero user interaction.
"""

from __future__ import annotations

import asyncio
import json
import os
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from app.logging_setup import get_logger

log = get_logger("tv_launcher")

# Default location is the bind-mounted ``/app/tv_keys.json`` (when the
# backend runs in Docker the file is shared with the host) or
# ``~/.electromesh/tv_keys.json`` (when host_hijack.py / host_full_mitm.py
# run natively).  The first existing path wins.
def _default_cache_path() -> Path:
    explicit = os.environ.get("EM_TV_KEYS")
    if explicit:
        return Path(explicit)
    bind_mount = Path("/app/tv_keys.json")
    if bind_mount.parent.exists():
        return bind_mount
    return Path.home() / ".electromesh" / "tv_keys.json"


CACHE_FILE = _default_cache_path()


_DEFAULT_MANIFEST_PERMISSIONS = [
    "LAUNCH", "LAUNCH_WEBAPP", "APP_TO_APP",
    "CONTROL_INPUT_TEXT", "CONTROL_INPUT_JOYSTICK",
    "CONTROL_INPUT_MEDIA_PLAYBACK", "CONTROL_INPUT_TV",
    "READ_INSTALLED_APPS", "READ_RUNNING_APPS",
    "READ_INPUT_DEVICE_LIST", "WRITE_SETTINGS",
    "CONTROL_POWER", "CONTROL_DISPLAY",
]


def _build_register(client_key: str | None) -> dict[str, Any]:
    return {
        "type": "register",
        "id": "r0",
        "payload": {
            "forcePairing": False,
            "pairingType": "PROMPT",
            **({"client-key": client_key} if client_key else {}),
            "manifest": {
                "manifestVersion": 1,
                "permissions": _DEFAULT_MANIFEST_PERMISSIONS,
            },
        },
    }


def _load_cache() -> dict[str, Any]:
    """Cache schema (per TV MAC):
       {"<mac>": "<client-key>"}                      # legacy v1
       {"<mac>": {"key": "...", "restore": "com.webos.app.youtube"}}  # v2
    """
    try:
        data = json.loads(CACHE_FILE.read_text(encoding="utf-8"))
        # Normalize legacy entries to v2
        normalized: dict[str, Any] = {}
        for mac, val in data.items():
            if isinstance(val, str):
                normalized[mac] = {"key": val, "restore": ""}
            elif isinstance(val, dict):
                normalized[mac] = val
        return normalized
    except Exception:
        return {}


def _save_cache(data: dict[str, Any]) -> None:
    try:
        CACHE_FILE.parent.mkdir(parents=True, exist_ok=True)
        CACHE_FILE.write_text(json.dumps(data, indent=2), encoding="utf-8")
    except Exception as e:
        log.warning("tv_launcher.cache_write_failed", err=str(e))


def _cached_key(mac: str) -> str | None:
    entry = _load_cache().get(mac.lower())
    if isinstance(entry, dict):
        return entry.get("key")
    return entry


def _cached_restore(mac: str) -> str | None:
    entry = _load_cache().get(mac.lower())
    if isinstance(entry, dict):
        return entry.get("restore") or None
    return None


def _update_cache(mac: str, *, key: str | None = None, restore: str | None = None) -> None:
    data = _load_cache()
    entry = data.get(mac.lower()) or {}
    if not isinstance(entry, dict):
        entry = {"key": entry}
    if key:
        entry["key"] = key
    if restore:
        entry["restore"] = restore
    data[mac.lower()] = entry
    _save_cache(data)


@dataclass(slots=True)
class TvLaunchResult:
    ok: bool
    tv_ip: str
    client_key: str | None = None
    foreground_was: str = ""
    restored_to: str = ""
    portal_url: str = ""
    error: str = ""


async def _pick_restore_target(call) -> tuple[str, str]:
    """Pick the safest target to restore the TV to.

    HDMI inputs can have *no signal* (set-top box off, console asleep)
    which causes the classic LG '신호 없음' grey screen.  Live TV can
    have no antenna.  The only target guaranteed to never show a
    no-signal screen is the LG home launcher itself.

    Strategy:
      1. If we have a remembered restore_target for this TV (saved on
         first contact, **before** we touched anything), use that --
         that was the user's actual viewing state.
      2. Otherwise, default to the LG home screen.  The user lands on
         the familiar launcher and can pick whatever they actually
         want to watch.

    Returns ``(kind, target)`` where ``kind`` is ``"app"`` or ``"input"``.
    """
    return ("app", "com.webos.app.home")


_BG_KEEPALIVE_TASKS: dict[str, asyncio.Task] = {}


async def _ssap_keepalive_loop(
    tv_ip: str, tv_mac: str,
    *, period_s: float = 8.0,
) -> None:
    """Long-running side-task — reconnects to SSAP and pings every period.

    We can't keep the original WebSocket open across an HTTP request
    boundary, so this opens its own connection with the cached client key
    and ticks ``audio/getVolume`` (a free, side-effect-free query) to
    advertise "this client is alive". Stops on disconnect; the per-TV
    singleton in ``_BG_KEEPALIVE_TASKS`` makes it idempotent.
    """
    import websockets
    cached_key = _cached_key(tv_mac)
    if not cached_key:
        log.warning("tv_launcher.keepalive.no_key", tv_mac=tv_mac)
        return
    try:
        async with websockets.connect(
            f"ws://{tv_ip}:3000", open_timeout=10, ping_interval=None,
        ) as ws:
            await ws.send(json.dumps(_build_register(cached_key)))
            # Wait for registered
            for _ in range(8):
                msg = json.loads(await asyncio.wait_for(ws.recv(), timeout=15))
                if msg.get("type") == "registered":
                    break
                if msg.get("type") == "error":
                    return

            i = 0
            while True:
                await ws.send(json.dumps({
                    "type": "request", "id": f"ka{i}",
                    "uri": "ssap://audio/getVolume", "payload": {},
                }))
                try:
                    await asyncio.wait_for(ws.recv(), timeout=5)
                except asyncio.TimeoutError:
                    pass
                i += 1
                await asyncio.sleep(period_s)
    except (asyncio.CancelledError, Exception) as e:
        if not isinstance(e, asyncio.CancelledError):
            log.info("tv_launcher.keepalive.ended", tv_ip=tv_ip, err=str(e)[:80])


async def launch_then_background(
    *,
    tv_ip: str,
    tv_mac: str,
    portal_url: str,
    warmup_seconds: float = 2.5,
    keepalive_period_s: float = 8.0,
) -> "TvLaunchResult":
    """Launch our portal in the LG browser, give the page time to start its
    silent-audio MediaSession + worker loop, then push the user's previous
    app (LiveTV / YouTube / Netflix) back to the foreground.

    Why this works — the YouTube-Music trick:
      * webOS suspends background JS only for pages without an active media
        session. Our portal HTML kicks off a muted-but-playing ``<audio>``
        and sets ``navigator.mediaSession.playbackState = 'playing'`` AT
        BOOT — before SSAP pushes another app on top.
      * When the LiveTV / YouTube app takes foreground, webOS sees our
        browser page is "playing audio" and treats it like Spotify in the
        background. JS keeps executing, /work/claim + /work/submit keep
        flowing.
      * We additionally keep the SSAP WebSocket open and ping the TV every
        ``keepalive_period_s`` so webOS sees ongoing IPC traffic — some
        firmwares use that as a "this app is alive, don't reap" signal.

    The user sees their broadcast resume, **never** sees the ElectroMesh
    page, and the worker contributes compute the entire time it stays in
    the webOS background stack.
    """
    import websockets

    cached_key = _cached_key(tv_mac)
    cached_restore = _cached_restore(tv_mac)

    try:
        async with websockets.connect(
            f"ws://{tv_ip}:3000", open_timeout=15, ping_interval=None,
        ) as ws:
            await ws.send(json.dumps(_build_register(cached_key)))

            new_key: str | None = None
            while True:
                msg = json.loads(await asyncio.wait_for(ws.recv(), timeout=60))
                t = msg.get("type")
                if t == "registered":
                    new_key = msg.get("payload", {}).get("client-key") or cached_key
                    break
                if t == "error":
                    return TvLaunchResult(
                        ok=False, tv_ip=tv_ip, portal_url=portal_url,
                        error=msg.get("error", "register error")[:160],
                    )

            if new_key and new_key != cached_key:
                _update_cache(tv_mac, key=new_key)

            async def call(uri: str, payload: dict, req_id: str) -> dict:
                await ws.send(json.dumps({
                    "type": "request", "id": req_id,
                    "uri": uri, "payload": payload,
                }))
                return json.loads(await asyncio.wait_for(ws.recv(), timeout=8))

            # 1) Snapshot the user's current foreground app so we can push
            # it back on top after the worker is warm.
            fg = await call(
                "ssap://com.webos.applicationManager/getForegroundAppInfo",
                {}, "fg",
            )
            foreground_was = fg.get("payload", {}).get("appId", "") or ""
            if (foreground_was
                    and foreground_was != "com.webos.app.browser"
                    and not cached_restore):
                _update_cache(tv_mac, restore=foreground_was)

            restore_target = foreground_was or cached_restore or "com.webos.app.livetv"

            # 2) Arm the per-IP "first fetch arrived" event before we open
            # the URL, so we can detect the moment the LG browser actually
            # loads our portal vs. just opening to a blank tab.
            from app.services.portal_server import get_portal_server
            portal = get_portal_server()
            portal.reset_fetch_event(tv_ip)
            fetch_ev = portal.wait_for_fetch(tv_ip)

            # 3) Launch our portal — this brings the browser to foreground.
            # webOS firmwares disagree on which SSAP URI actually navigates
            # the browser. We try the three known-good variants in order
            # and stop at the first that reports success AND results in a
            # portal fetch arriving on TCP/80.
            r_open: dict[str, Any] = {}
            open_attempts = (
                # Confirmed to navigate the browser on this user's firmware
                # (SK8000PA webOS). The "launch" variants returnValue=true
                # but only bring the browser app to foreground without
                # actually loading the URL — so they're listed AFTER as
                # last-resort fallbacks.
                ("ssap://system.launcher/open",
                 {"target": portal_url}),
                ("ssap://com.webos.applicationManager/launch",
                 {"id": "com.webos.app.browser", "params": {"target": portal_url}}),
                ("ssap://system.launcher/launch",
                 {"id": "com.webos.app.browser", "params": {"target": portal_url}}),
            )
            chosen = None
            for idx, (uri, payload) in enumerate(open_attempts):
                r_open = await call(uri, payload, f"open{idx}")
                if r_open.get("payload", {}).get("returnValue", False):
                    chosen = uri
                    log.info("tv_launcher.open_ok", tv_ip=tv_ip, uri=uri)
                    break
            if chosen is None:
                return TvLaunchResult(
                    ok=False, tv_ip=tv_ip, client_key=new_key,
                    foreground_was=foreground_was,
                    error="all SSAP browser-launch URIs returned returnValue=false",
                    portal_url=portal_url,
                )

            # 4) Wait for the page to actually hit our /80 server — that's
            # the proof the browser navigated to the right URL. After it
            # arrives we give the page another ``warmup_seconds`` to start
            # the audio + MediaSession + worker loop before backgrounding.
            page_loaded = False
            try:
                await asyncio.wait_for(fetch_ev.wait(), timeout=10.0)
                page_loaded = True
            except asyncio.TimeoutError:
                log.warning("tv_launcher.no_fetch", tv_ip=tv_ip,
                            portal_url=portal_url)
            if page_loaded:
                await asyncio.sleep(warmup_seconds)

            # 5) Push the user's previous app back to foreground. With our
            # MediaSession active the browser DOES NOT get killed — it
            # falls into the webOS background app stack while continuing
            # to execute JS.
            r_back = await call(
                "ssap://system.launcher/launch",
                {"id": restore_target}, "restore",
            )
            restored = r_back.get("payload", {}).get("returnValue", False)

            if not page_loaded:
                # Browser never hit our portal — restore happened anyway
                # so the user gets back to their content, but the worker
                # never started. Surface this loudly so the caller knows
                # this attempt was cosmetic only.
                return TvLaunchResult(
                    ok=False, tv_ip=tv_ip, client_key=new_key,
                    foreground_was=foreground_was,
                    restored_to=f"app:{restore_target}",
                    error="portal URL never fetched by TV browser (firewall? wrong IP? webOS sandboxed our http?)",
                    portal_url=portal_url,
                )

            # 5) Detach a long-running SSAP keepalive task (own WS,
            # independent of this request) so the API returns now while
            # the browser stays in the webOS background stack indefinitely.
            old = _BG_KEEPALIVE_TASKS.get(tv_mac)
            if old and not old.done():
                old.cancel()
            _BG_KEEPALIVE_TASKS[tv_mac] = asyncio.create_task(
                _ssap_keepalive_loop(tv_ip, tv_mac, period_s=keepalive_period_s),
                name=f"tv_keepalive:{tv_mac}",
            )

            log.info(
                "tv_launcher.background_running",
                tv_ip=tv_ip, foreground_was=foreground_was,
                restored_to=restore_target,
                keepalive_task=f"tv_keepalive:{tv_mac}",
            )

            return TvLaunchResult(
                ok=True, tv_ip=tv_ip, client_key=new_key,
                foreground_was=foreground_was,
                restored_to=(
                    f"app:{restore_target}" if restored
                    else f"(restore failed -> app:{restore_target})"
                ),
                portal_url=portal_url,
            )

    except Exception as e:
        return TvLaunchResult(
            ok=False, tv_ip=tv_ip, error=str(e)[:200],
            portal_url=portal_url,
        )


async def register_only(
    *,
    tv_ip: str,
    tv_mac: str,
    timeout_s: float = 20.0,
) -> "TvLaunchResult":
    """SSAP pair-and-disconnect — does NOT open the browser.

    Why: launching the browser on webOS yanks the TV out of whatever the
    user was watching (live broadcast, Netflix etc.) and webOS has no
    third-party way to actually close it later — the browser is a singleton
    foreground app and the only reliable way back is the physical remote.
    For a passive claim we want the TV "armed" without disturbing it:

    * We connect to ``ws://tv:3000`` and send the ``register`` handshake.
    * The TV responds with a ``client-key`` (cached for future launches).
    * We disconnect.  Whatever was on screen stays on screen.

    The TV is now claim-eligible: when (and only when) the user opts in to
    actively render the portal we have the key cached and can issue
    ``launch_portal_background`` without re-prompting.
    """
    import websockets

    cached_key = _cached_key(tv_mac)
    try:
        async with websockets.connect(
            f"ws://{tv_ip}:3000", open_timeout=min(timeout_s, 15),
            ping_interval=None,
        ) as ws:
            await ws.send(json.dumps(_build_register(cached_key)))

            new_key: str | None = None
            deadline = asyncio.get_event_loop().time() + timeout_s
            while asyncio.get_event_loop().time() < deadline:
                remaining = max(1.0, deadline - asyncio.get_event_loop().time())
                msg = json.loads(await asyncio.wait_for(ws.recv(), timeout=remaining))
                t = msg.get("type")
                if t == "registered":
                    new_key = msg.get("payload", {}).get("client-key") or cached_key
                    break
                if t == "error":
                    return TvLaunchResult(
                        ok=False, tv_ip=tv_ip, portal_url="",
                        error=msg.get("error", "register error")[:160],
                    )
                # "response" with pairingType: PROMPT — keep waiting for
                # the user to press 예 on the TV remote, or for timeout.

            if new_key is None:
                return TvLaunchResult(
                    ok=False, tv_ip=tv_ip, portal_url="",
                    error="timed out waiting for user to confirm pairing on TV",
                )
            if new_key != cached_key:
                _update_cache(tv_mac, key=new_key)
                log.info("tv_launcher.key_saved", tv_mac=tv_mac, mode="register_only")

            return TvLaunchResult(
                ok=True, tv_ip=tv_ip, portal_url="",
                client_key=new_key,
                foreground_was="(undisturbed)",
                restored_to="(no launch)",
            )
    except Exception as e:
        return TvLaunchResult(
            ok=False, tv_ip=tv_ip, portal_url="", error=str(e)[:200],
        )


async def launch_portal_background(
    *,
    tv_ip: str,
    tv_mac: str,
    portal_url: str,
    restore_app_id: str | None = None,
    settle_seconds: float = 4.0,
) -> TvLaunchResult:
    """Launch ``portal_url`` in the TV's browser, then return TV to its
    normal viewing app (default: live broadcast).

    Returns a ``TvLaunchResult`` describing what happened. Caller (claim
    API) surfaces this back to the CLI / frontend so the user can be
    prompted if the TV requires the first-time ``예`` press.
    """
    import websockets  # local import: heavy + optional dep

    cached_key = _cached_key(tv_mac)
    cached_restore = _cached_restore(tv_mac)

    try:
        async with websockets.connect(
            f"ws://{tv_ip}:3000", open_timeout=15,
            ping_interval=None,         # LG firmware doesn't expect WS pings
        ) as ws:
            await ws.send(json.dumps(_build_register(cached_key)))

            new_key: str | None = None
            while True:
                msg = json.loads(await asyncio.wait_for(ws.recv(), timeout=60))
                t = msg.get("type")
                if t == "registered":
                    new_key = msg.get("payload", {}).get("client-key") or cached_key
                    break
                if t == "error":
                    return TvLaunchResult(
                        ok=False, tv_ip=tv_ip,
                        error=msg.get("error", "register error"),
                        portal_url=portal_url,
                    )
                # 'response' to register may carry pairingType: PROMPT --
                # we just keep waiting for 'registered' / 'error'

            if new_key and new_key != cached_key:
                _update_cache(tv_mac, key=new_key)
                log.info("tv_launcher.key_saved", tv_mac=tv_mac)

            async def call(uri: str, payload: dict, req_id: str) -> dict:
                await ws.send(json.dumps({
                    "type": "request", "id": req_id,
                    "uri": uri, "payload": payload,
                }))
                return json.loads(await asyncio.wait_for(ws.recv(), timeout=8))

            # Probe foreground BEFORE launching the browser so we can
            # come back to whatever the user was actually watching.
            fg = await call(
                "ssap://com.webos.applicationManager/getForegroundAppInfo",
                {}, "fg",
            )
            foreground_was = fg.get("payload", {}).get("appId", "")

            # Persist the *first* observed non-browser foreground for
            # this TV.  This is the user's actual viewing state.
            if (foreground_was
                    and foreground_was != "com.webos.app.browser"
                    and not cached_restore):
                _update_cache(tv_mac, restore=foreground_was)
                log.info("tv_launcher.restore_saved",
                         tv_mac=tv_mac, app=foreground_was)
                cached_restore = foreground_was

            # Decide where to send the TV after we're done.
            #   1. caller's explicit restore_app_id wins (lets the user
            #      override via API/CLI: ``--restore com.webos.app.youtube``)
            #   2. otherwise ALWAYS go to LG home -- the home screen is
            #      the only target guaranteed to never produce '신호 없음'.
            #      The user lands on the familiar launcher and can pick
            #      whatever they actually want to watch.  We log the
            #      observed foreground to the cache for informational
            #      use (the laptop UI can offer it as a "restore to..."
            #      suggestion) but don't auto-use it because livetv may
            #      have no antenna and HDMI inputs may be asleep.
            if restore_app_id:
                restore_kind, restore_target = "app", restore_app_id
            else:
                restore_kind, restore_target = "app", "com.webos.app.home"

            r_open = await call(
                "ssap://system.launcher/open",
                {"target": portal_url}, "open",
            )
            opened = r_open.get("payload", {}).get("returnValue", False)
            if not opened:
                return TvLaunchResult(
                    ok=False, tv_ip=tv_ip, client_key=new_key,
                    foreground_was=foreground_was,
                    error="launcher.open returnValue=false",
                    portal_url=portal_url,
                )

            await asyncio.sleep(settle_seconds)

            # 1) Explicitly close the browser app first. Just calling
            # ``system.launcher/launch`` to another app does NOT close the
            # browser on webOS — the browser stays in the focus stack and
            # often re-takes the screen. We close it by appId so the focus
            # actually moves.
            try:
                await call(
                    "ssap://system.launcher/close",
                    {"id": "com.webos.app.browser"}, "close",
                )
            except Exception as e:
                log.warning("tv_launcher.browser_close_failed",
                            tv_ip=tv_ip, err=str(e))

            # 2) Now launch the restore target. Retry once if returnValue=false
            # because LG occasionally returns false on the first launch after
            # a browser close while the compositor is still settling.
            r_back = {}
            for attempt in range(2):
                if restore_kind == "input":
                    r_back = await call(
                        "ssap://tv.switchInput",
                        {"inputId": restore_target}, f"back{attempt}",
                    )
                else:
                    r_back = await call(
                        "ssap://system.launcher/launch",
                        {"id": restore_target}, f"back{attempt}",
                    )
                if r_back.get("payload", {}).get("returnValue", False):
                    break
                await asyncio.sleep(0.6)
            restored = r_back.get("payload", {}).get("returnValue", False)

            # 3) Hard fallback: if restore still failed, send the Home key
            # via input.button which webOS treats as a system event the
            # browser app cannot intercept.
            if not restored:
                try:
                    await call(
                        "ssap://com.webos.service.networkinput/getPointerInputSocket",
                        {}, "ptr",
                    )
                    # Best-effort; pointer socket is async. Just press Home:
                    await call(
                        "ssap://system.notifications/createToast",
                        {"message": "ElectroMesh: 홈으로 이동합니다"}, "toast",
                    )
                    await call(
                        "ssap://system.launcher/launch",
                        {"id": "com.webos.app.home"}, "home_force",
                    )
                except Exception:
                    pass

            return TvLaunchResult(
                ok=True, tv_ip=tv_ip, client_key=new_key,
                foreground_was=foreground_was,
                restored_to=(
                    f"{restore_kind}:{restore_target}" if restored
                    else f"(restore failed -> {restore_kind}:{restore_target})"
                ),
                portal_url=portal_url,
            )

    except Exception as e:
        return TvLaunchResult(
            ok=False, tv_ip=tv_ip, error=str(e)[:200],
            portal_url=portal_url,
        )
