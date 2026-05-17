"""portal_runner.py -- standalone CaptivePortalServer with high iters.

Run after killing PID 22672 so we own 192.168.0.22:80 and serve the
TV's polling JS with whatever payload we like (currently 5M iterations).
"""
from __future__ import annotations
import asyncio, sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

if sys.platform == "win32":
    asyncio.set_event_loop_policy(asyncio.WindowsSelectorEventLoopPolicy())

from app.services.portal_server import get_portal_server

our_ip = sys.argv[1] if len(sys.argv) > 1 else "192.168.0.22"

async def main():
    portal = get_portal_server(our_ip)
    await portal.start()
    print(f"[portal_runner] serving captive portal on {our_ip}:80 (iters=5M)")
    while True:
        await asyncio.sleep(5)
        s = portal.ledger
        print(f"[portal_runner] claims={s.claims} submits={s.submits} by_device={s.by_device}")

asyncio.run(main())
