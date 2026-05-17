"""Probe every known SSAP browser-launch shape against this LG TV until
one of them actually navigates to our portal. We measure success by
watching for an HTTP hit on the portal stats counter."""
import asyncio, json, urllib.request

TV = "ws://192.168.0.12:3000"
PORTAL = "http://192.168.0.22/"
CLIENT_KEY = "27304a5ee263d132755e7fa9a262f4c3"
STATS = "http://192.168.0.22/v1/claim/portal/stats"

import websockets

REGISTER = {
    "type":"register","id":"r0",
    "payload":{"forcePairing":False,"pairingType":"PROMPT",
        "client-key":CLIENT_KEY,
        "manifest":{"manifestVersion":1,"permissions":[
            "LAUNCH","LAUNCH_WEBAPP","APP_TO_APP",
            "CONTROL_INPUT_TEXT","CONTROL_INPUT_JOYSTICK",
            "READ_INSTALLED_APPS","WRITE_NOTIFICATION_ALERT",
            "WRITE_SETTINGS","CONTROL_POWER"]}},
}

VARIANTS = [
    ("system.launcher/open  target",      "ssap://system.launcher/open",
     {"target": PORTAL}),
    ("system.launcher/open  url",         "ssap://system.launcher/open",
     {"url": PORTAL}),
    ("system.launcher/launch browser+target", "ssap://system.launcher/launch",
     {"id":"com.webos.app.browser","params":{"target":PORTAL}}),
    ("system.launcher/launch browser+url",    "ssap://system.launcher/launch",
     {"id":"com.webos.app.browser","params":{"url":PORTAL}}),
    ("webapp/launch target",              "ssap://webapp/launch",
     {"target": PORTAL}),
    ("applicationManager browser+target", "ssap://com.webos.applicationManager/launch",
     {"id":"com.webos.app.browser","params":{"target":PORTAL}}),
    ("applicationManager browser+url",    "ssap://com.webos.applicationManager/launch",
     {"id":"com.webos.app.browser","params":{"url":PORTAL}}),
    ("applicationManager browser+contentTarget",
     "ssap://com.webos.applicationManager/launch",
     {"id":"com.webos.app.browser","params":{"contentTarget":PORTAL}}),
]

def claims_now():
    try:
        with urllib.request.urlopen(STATS, timeout=3) as r:
            j = json.loads(r.read())
            return j.get("claims", 0)
    except Exception:
        return None

async def main():
    async with websockets.connect(TV, open_timeout=8, ping_interval=None) as ws:
        await ws.send(json.dumps(REGISTER))
        for _ in range(8):
            obj = json.loads(await asyncio.wait_for(ws.recv(), timeout=15))
            if obj.get("type") == "registered":
                break
        for i, (label, uri, payload) in enumerate(VARIANTS):
            baseline = claims_now()
            await ws.send(json.dumps({
                "type":"request","id":f"v{i}","uri":uri,"payload":payload,
            }))
            try:
                resp = json.loads(await asyncio.wait_for(ws.recv(), timeout=8))
            except asyncio.TimeoutError:
                resp = {"type":"timeout"}
            rv = resp.get("payload",{}).get("returnValue", None)
            await asyncio.sleep(6)
            after = claims_now()
            delta = (after - baseline) if (after is not None and baseline is not None) else None
            mark = "HIT" if (delta and delta > 0) else "no fetch"
            print(f"[{mark:>8}] {label:<46} rv={rv} delta={delta}")
            # Close the browser before the next attempt so each one is fresh
            await ws.send(json.dumps({
                "type":"request","id":f"c{i}",
                "uri":"ssap://system.launcher/close",
                "payload":{"id":"com.webos.app.browser"},
            }))
            try: await asyncio.wait_for(ws.recv(), timeout=4)
            except Exception: pass
            await asyncio.sleep(2)

asyncio.run(main())
