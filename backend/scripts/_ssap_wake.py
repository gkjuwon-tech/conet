"""Try to wake the LG TV via SSAP — register, then either toast or
launch the browser pointed at our captive portal."""
import asyncio, json, sys
try:
    import websockets
except ImportError:
    import subprocess
    subprocess.run([sys.executable, "-m", "pip", "install", "--quiet", "websockets"], check=True)
    import websockets

TV = "ws://192.168.0.12:3000"
PORTAL = "http://192.168.0.22/"

REGISTER_PAYLOAD = {
    "type": "register",
    "id": "register_0",
    "payload": {
        "forcePairing": False,
        "pairingType": "PROMPT",
        "manifest": {
            "manifestVersion": 1,
            "appVersion": "1.1",
            "signed": {
                "created": "20140509",
                "appId": "com.lge.test",
                "vendorId": "com.lge",
                "localizedAppNames": {"": "ElectroMesh"},
                "permissions": [
                    "LAUNCH", "LAUNCH_WEBAPP", "APP_TO_APP",
                    "CLOSE", "TEST_OPEN", "TEST_PROTECTED",
                    "CONTROL_AUDIO", "CONTROL_DISPLAY", "CONTROL_INPUT_JOYSTICK",
                    "CONTROL_INPUT_MEDIA_RECORDING", "CONTROL_INPUT_MEDIA_PLAYBACK",
                    "CONTROL_INPUT_TV", "CONTROL_POWER",
                    "READ_INSTALLED_APPS", "READ_LGE_SDX", "READ_NOTIFICATIONS",
                    "SEARCH", "WRITE_SETTINGS", "WRITE_NOTIFICATION_ALERT",
                ],
            },
            "permissions": ["LAUNCH", "LAUNCH_WEBAPP", "CONTROL_INPUT_TEXT"],
            "signatures": [{"signatureVersion": 1, "signature": "eyJh..."}],
        },
    },
}

async def main():
    async with websockets.connect(TV, open_timeout=5) as ws:
        print(f"[+] connected to {TV}")
        await ws.send(json.dumps(REGISTER_PAYLOAD))
        for _ in range(20):
            try:
                msg = await asyncio.wait_for(ws.recv(), timeout=6)
            except asyncio.TimeoutError:
                print("[ ] still waiting for TV remote OK press...")
                continue
            obj = json.loads(msg)
            print(f"[<-] {obj.get('type')}  {str(obj)[:200]}")
            if obj.get("type") == "registered":
                print("[+] REGISTERED — sending launcher.open for browser")
                await ws.send(json.dumps({
                    "type": "request", "id": "open_1",
                    "uri": "ssap://system.launcher/open",
                    "payload": {"target": PORTAL},
                }))
            elif obj.get("type") == "response" and obj.get("id") == "open_1":
                print(f"[+] BROWSER LAUNCH response: {obj}")
                break
            elif obj.get("type") == "error":
                print(f"[!] TV said NO -- giving up")
                break

asyncio.run(main())
