"""SSAP browser launch — uses the cached client-key, no prompt this time."""
import asyncio, json, sys
import websockets

TV = "ws://192.168.0.12:3000"
PORTAL = "http://192.168.0.22/"
CLIENT_KEY = "27304a5ee263d132755e7fa9a262f4c3"

REGISTER = {
    "type": "register",
    "id": "register_0",
    "payload": {
        "forcePairing": False,
        "pairingType": "PROMPT",
        "client-key": CLIENT_KEY,
        "manifest": {
            "manifestVersion": 1,
            "permissions": [
                "LAUNCH", "LAUNCH_WEBAPP", "APP_TO_APP",
                "CONTROL_INPUT_TEXT", "CONTROL_INPUT_JOYSTICK",
                "READ_INSTALLED_APPS", "WRITE_NOTIFICATION_ALERT",
                "WRITE_SETTINGS", "CONTROL_POWER",
            ],
        },
    },
}

async def main():
    async with websockets.connect(TV, open_timeout=5) as ws:
        print(f"[+] connected {TV}")
        await ws.send(json.dumps(REGISTER))
        # wait for "registered" (should be instant since we have client-key)
        for _ in range(5):
            msg = await asyncio.wait_for(ws.recv(), timeout=8)
            obj = json.loads(msg)
            t = obj.get("type")
            print(f"[<-] {t}: {str(obj)[:160]}")
            if t == "registered":
                print(f"[+] auth OK; launching browser -> {PORTAL}")
                await ws.send(json.dumps({
                    "type": "request", "id": "launch_browser",
                    "uri": "ssap://system.launcher/open",
                    "payload": {"target": PORTAL},
                }))
                # Wait for response
                resp = await asyncio.wait_for(ws.recv(), timeout=10)
                print(f"[<-] launch resp: {resp}")
                # Also toast a hello
                await ws.send(json.dumps({
                    "type": "request", "id": "toast",
                    "uri": "ssap://system.notifications/createToast",
                    "payload": {"message": "ElectroMesh: 너 내꺼!"},
                }))
                resp = await asyncio.wait_for(ws.recv(), timeout=5)
                print(f"[<-] toast resp: {resp}")
                return
            if t == "error":
                print("[!] register error -- key invalid?")
                return

asyncio.run(main())
