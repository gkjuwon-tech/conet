# ElectroMesh Backend

Distributed compute marketplace that leases ~10% of consumers' electronics
(PCs, NAS, smart TVs, even down to smart bulbs) and resells aggregated capacity
as virtual H100-equivalent clusters to enterprises for security workloads
(hash cracking, FHE/MPC shares, etc.). Users earn USD payouts proportional to
how much their devices contributed.

## Architecture

```
+------------------+        +------------------+        +------------------+
|   User devices   | <----> |  WiFi-piggyback  | <----> |  ElectroMesh API |
| (PC, NAS, TV, IoT|  WSS   |  agent (router/  |  HTTPS |  + dispatcher    |
|  smart bulbs..)  |        |  desktop)        |        |  + bundler       |
+------------------+        +------------------+        +--------+---------+
                                                                 |
                                                                 v
                                                        +-----------------+
                                                        | Marketplace UI  |
                                                        | for enterprises |
                                                        +-----------------+
```

### Key flows
1. **Onboarding** – User registers, installs the WiFi agent, registers each
   device. Agent runs benchmarks; `services.benchmark` sanitizes them and
   computes an H100-equivalent score per device.
2. **Bundling** – `services.bundling.FCFSBundler` groups idle devices into
   strict first-come-first-served clusters of size N. Every cluster is priced
   individually based on the actual mix (`services.pricing`).
3. **Marketplace** – Enterprises browse / quote / buy. Job submission goes
   through `services.isolation` to enforce that no plaintext or PII ever leaves
   the orchestrator.
4. **Dispatch** – `services.dispatcher` chunks jobs into work units with
   redundancy, dispatches to devices, and runs consensus on returned results.
5. **Settlement** – `services.settlement` splits the post-fee pool by
   `runtime_ms × reliability` per device and credits each user's wallet.
   `billing.payouts` opens weekly Stripe transfers.

## Layout

```
app/
├── api/v1/        # FastAPI routers (users, devices, clusters, jobs,
│                  #   marketplace, payouts, enterprise, admin, agent)
├── auth/          # JWT, bcrypt, scope-aware dependencies
├── billing/       # Stripe adapter + payout worker
├── crypto/        # Workunit chunkers, hash workloads, attestation
├── db/            # SQLAlchemy 2.x async models + sessions
├── networking/    # Agent wire protocol + WebSocket hub
├── observability/ # Prometheus metrics + middleware
├── schemas/       # Pydantic v2 schemas
├── services/      # benchmark, pricing, bundling, dispatcher, settlement,
│                  # isolation, fraud, reputation, heartbeat, wifi_agent
├── utils/         # ids, time, money helpers
├── config.py
├── exceptions.py
├── logging_setup.py
└── main.py        # FastAPI app factory + lifespan
alembic/           # Initial migration
tests/             # Pure-function tests (pricing, chunker, isolation, etc.)
```

## Run

```bash
uv sync
alembic upgrade head
uvicorn app.main:app --host 0.0.0.0 --port 8080 --reload
```
