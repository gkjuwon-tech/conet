import asyncio, sys, os
if sys.platform == "win32":
    asyncio.set_event_loop_policy(asyncio.WindowsSelectorEventLoopPolicy())
os.chdir(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import uvicorn
# uvicorn.run() ignores asyncio.set_event_loop_policy on Windows and creates
# its own ProactorEventLoop, which psycopg refuses. Build a Server manually
# and feed it to asyncio.run() so the SelectorEventLoop sticks.
config = uvicorn.Config("app.main:app", host="0.0.0.0", port=8080,
                        log_level="info", reload=False, loop="asyncio")
server = uvicorn.Server(config)
asyncio.run(server.serve())
