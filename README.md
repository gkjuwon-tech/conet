# ElectroMesh

Three artifacts in this repo:

```
backend/                  FastAPI backend (Postgres + Redis + Celery)
electromesh-consumer/     Electron desktop app for individual users
                          — pairs the host as a device + runs hash workers
electromesh-enterprise/   Electron desktop app for enterprises
                          — marketplace, jobs, API keys, billing
```

## What it is

Distributed compute marketplace. Users lease ~10% of their idle electronics
(PCs first, smart TVs, NAS, even down to smart bulbs over time). The backend
strict-FCFS bundles devices into virtual clusters of N, prices each cluster
based on the actual mix, and rents them out to enterprises for security
workloads (hash crack, FHE/MPC shares, etc.).

Enterprise data **never** lands on a consumer device — only ranged keyspaces
or share indices do. Each workunit is verified via 2–3× redundancy with
consensus-based reward release.

## Connecting the parts locally

```
backend$ uvicorn app.main:app --reload --port 8080

electromesh-consumer$ pnpm install && pnpm dev
electromesh-enterprise$ pnpm install && pnpm dev
```

Both apps default to `http://localhost:8080` and can be retargeted via the
Settings screen or `EM_API_BASE` env var.

## Building distributables

Each app produces a **real `.exe` and real `.dmg`** via electron-builder:

```
electromesh-consumer$ pnpm build:win   # → release/ElectroMesh-0.1.0-Setup.exe
electromesh-consumer$ pnpm build:mac   # → release/ElectroMesh-0.1.0-arm64.dmg

electromesh-enterprise$ pnpm build:win # → release/ElectroMesh-Enterprise-0.1.0-Setup.exe
electromesh-enterprise$ pnpm build:mac # → release/ElectroMesh-Enterprise-0.1.0-arm64.dmg
```

Or `pnpm build:all` from each app to produce both targets in one shot
(requires a macOS host for the dmg or proper cross-compile config).

## End-to-end flow

1. **Operator** runs the backend; an admin creates an `Enterprise` row and
   mints an API key.
2. **User** installs the consumer app, registers, and pairs the laptop. The
   app benchmarks itself, registers a `Device`, and starts the agent.
3. The backend's FCFS bundler folds the device into a virtual cluster as soon
   as enough devices are queued. The cluster gets priced per its mix.
4. **Enterprise** pastes the API key into the enterprise app, browses the
   marketplace, adds clusters to a cart, submits a job (hash crack as a first
   wizard, others via raw manifest API).
5. The consumer agent picks up workunits via `/v1/agent/work/claim`, runs
   them in `worker_threads`, and reports results. After redundancy and
   consensus, the user's wallet is credited; payouts go out via Stripe.
