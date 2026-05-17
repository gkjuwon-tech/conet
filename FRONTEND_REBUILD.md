# FRONTEND_REBUILD.md

> Both Electron renderers (`electromesh-consumer/` and `electromesh-enterprise/`)
> were nuked on purpose — they will be rebuilt from scratch.
>
> This document is the contract: **what the apps must do**, **what backend
> endpoints they call**, and **what IPC surface the renderer expects from the
> Electron main process**. The backend (`backend/`), the design tokens
> (`design/`), the `package.json` / `tsconfig*.json` / `electron.vite.config.ts`
> for each app, the HTML entrypoints and the build resources are all kept.
>
> The previous implementation is preserved in git history at commit
> `0ba636d` if any specific piece needs to be referenced.

---

## 0. Repo layout (what's still here)

```
backend/                       FastAPI · Postgres · Redis · Celery — UNCHANGED
design/
  tokens.css                   design system tokens (dark/light/ivory themes)
  base.css                     base resets
  primitives.css               primitive components (em-btn, em-card, etc.)
  fonts/                       Berkeley Mono / Inter Tight font face declarations
electromesh-consumer/
  package.json                 dev/build scripts kept
  electron.vite.config.ts      vite config for main/preload/renderer kept
  tsconfig*.json               TS configs kept
  build/                       app icons kept
  src/                         EMPTY — rebuild here
electromesh-enterprise/        same shape, src/ also empty
docker-compose.yml             local Postgres+Redis+backend dev stack
```

`npm run dev` in either app folder runs `electron-vite dev` which expects:

```
src/main/index.ts              Electron main entry → boots BrowserWindow
src/preload/index.ts           contextBridge → exposes window.electromesh.*
src/renderer/main.tsx          React entry (loaded by src/renderer/index.html)
src/renderer/index.html        already references ./main.tsx
```

The HTML for **consumer** is `electromesh-consumer/src/renderer/index.html`
(also nuked — recreate it; the old version set `data-theme` on `<html>` from
`localStorage["conet:theme"]` defaulting to `"dark"` to avoid FOUC, and
loaded `./main.tsx` as a module).

---

## 1. Backend connection (same for both apps)

* Base URL: `http://localhost:8080` in dev (override with `EM_API_BASE`).
* All endpoints are JSON over HTTP, prefixed `/v1/...`.
* Health: `GET /healthz` → `{status:"ok"}`, `GET /readyz` → `{status:"ready"}`.
* Auth scheme: bearer JWT in `Authorization: Bearer <token>` header.
  * **Consumer** gets a *user JWT* from `POST /v1/users/login`
    (response: `{access_token, refresh_token, token_type:"bearer"}`).
  * **Consumer** also issues a *device JWT* via
    `POST /v1/devices/{device_id}/issue-token` after `POST /v1/devices/register`.
  * **Enterprise** never gets a JWT — it talks to the API with an
    *enterprise API key* (`X-API-Key: em_live_...`) it pastes in once.
* CORS: backend allows `*` in dev. The CSP in the renderer's `index.html`
  must include `connect-src 'self' http://localhost:* ws://localhost:* https://* wss://*`.
* When the API returns 401, the Electron main process should flush the stored
  token and broadcast IPC `auth:logged-out` so the renderer can route to `/login`.

A local backend is brought up by `docker compose up -d` from the repo root
(it builds the backend image, starts Postgres + Redis, runs `alembic upgrade
head`, and runs `python -m scripts.bootstrap` once to create the `demo`
enterprise + admin API key — the key is written to `/app/.bootstrap.json`
inside the backend container; read it via
`docker exec electromesh-backend-1 cat /app/.bootstrap.json`).

For Fly deployment: `cd backend && flyctl deploy` — full runbook in
`backend/FLY_DEPLOYMENT.md` (requires Fly Managed Postgres + Upstash Redis
secrets, see step 1–2 of that file).

---

## 2. Consumer app — feature spec

### 2.1 What the app is

A desktop daemon that lets a household "lease" the idle cycles of their
plugged-in devices (laptop, phones, smart TV, NAS, light bulbs …) to the
conet marketplace and earn payouts. Tray-resident; opens the dashboard
window on click.

### 2.2 Screens / routes

| Route                  | Purpose                                                              |
| ---------------------- | -------------------------------------------------------------------- |
| `/login`               | Email + password sign in. Google + Apple OAuth buttons.              |
| `/register`            | Email + password sign up. Live password rules, country (ISO-2), TOS. |
| `/onboarding`          | First-run picker after register: "scan my Wi-Fi" vs "skip for now".  |
| `/`                    | Dashboard — earnings KPIs, active workunits, top devices.            |
| `/devices`             | List of paired devices with status pills.                            |
| `/devices/new`         | Pair the local host as a device (benchmark → register).              |
| `/devices/claim`       | Manual "claim a single LAN IP" flow (advanced).                      |
| `/devices/lan-wizard`  | Multi-step "scan → review → batch pair" wizard for the whole LAN.    |
| `/devices/android`     | Android phone agent pairing (ADB-WiFi based; uses `/v1/android/*`).  |
| `/devices/:id`         | Per-device detail: benchmark history, earnings, decommission.        |
| `/earnings`            | Earnings ledger / history table.                                     |
| `/payouts`             | Payout history + "request payout" button.                            |
| `/settings`            | API base URL, theme, agent on/off, logout.                           |

### 2.3 Backend endpoints the consumer calls

Auth & user:
* `POST /v1/users/register`     `{email, password, display_name?, country_code?, accepted_tos_version}`
* `POST /v1/users/login`        `{email, password}` → `{access_token, refresh_token}`
* `GET  /v1/users/me`           → current user
* `PATCH /v1/users/me`          `{display_name?, country_code?, preferences?}`
* `GET  /v1/users/me/dashboard` → KPIs for the dashboard page
* `GET  /v1/users/oauth/providers`        → which OAuth providers are configured
* `POST /v1/users/oauth/{provider}/start` → returns `{authorize_url, state}`
* `GET  /v1/users/oauth/{provider}/callback?code=&state=` → HTML page that posts the token back
* `POST /v1/users/oauth/{provider}/dev-login` → dev-only shortcut

Devices:
* `POST /v1/devices/register`                 `{label?, device_class, capabilities?, consents?}`
* `GET  /v1/devices`                          → list of my devices
* `GET  /v1/devices/{id}` / `PATCH` / `POST /{id}/decommission`
* `POST /v1/devices/{id}/issue-token`         → device JWT (used by the agent loop)
* `POST /v1/devices/{id}/benchmark`           `{hashrate_mhs, ram_mb, power_w, ...}`
* `POST /v1/devices/me/heartbeat`             (sent by the agent every ~15s)

Agent loop (uses device JWT, runs in the Electron main process worker):
* `POST /v1/agent/attest/challenge` → `{nonce}`
* `POST /v1/agent/attest/verify`    `{signature, nonce}`
* `POST /v1/agent/heartbeat`        `{cpu_pct, ram_pct, temp_c, battery_pct?, charging?}`
* `POST /v1/agent/work/claim`       → next workunit, or 204 if nothing queued
* `POST /v1/agent/work/submit`      `{workunit_id, result, duration_ms, ...}`

Economics:
* `GET  /v1/economics/tariffs` / `/power-profiles`
* `GET  /v1/economics/device/{id}` → economic snapshot for that device
* `POST /v1/economics/should-work` `{device_id, ambient_c?, battery_pct?, charging?}`
   → `{should_work: bool, reasons: [...]}` (gate before claiming work)

LAN claim flow (turning random LAN devices into paired devices):
* `POST /v1/claim/scan` → kicks off a network scan
* `GET  /v1/claim/scan/results` → list of discovered devices
* `POST /v1/claim/execute` / `execute-all` / `release/{ip}` / `fleet`
* `POST /v1/lan-claims` / `POST /v1/lan-claims/verify` / `GET /v1/lan-claims`
* TV-specific helpers under `/v1/claim/tv/*`, `/v1/claim/fakedns/*`,
  `/v1/claim/aggressive/*` (advanced; only LanWizard uses these).

Android pairing:
* `GET  /v1/android/status`
* `POST /v1/android/discover` + `GET /v1/android/discover/results`
* `POST /v1/android/enroll` / `enroll-many`
* `POST /v1/android/friends` / `POST /v1/android/friends/veto/{ip}`

Payouts:
* `GET  /v1/payouts` / `GET /v1/payouts/{id}` / `GET /v1/payouts/{id}/ledger`
* `POST /v1/payouts/request`

### 2.4 IPC surface the renderer expects

The Electron preload must expose `window.electromesh` with this exact shape
(it's what every page imports via `src/renderer/api/bridge.ts`):

```ts
window.electromesh = {
  config: {
    get(): Promise<{ apiBase: string; preferences: Record<string, unknown> }>,
    set(payload: { apiBase?: string; preferences?: Record<string, unknown> }): Promise<void>,
  },
  auth: {
    state(): Promise<{ authenticated: boolean; user?: User; error?: string }>,
    login(payload: { email: string; password: string }): Promise<{ ok: boolean; user?: User; error?: string }>,
    register(payload: { email: string; password: string; display_name?: string;
                        country_code?: string; accepted_tos_version: string })
      : Promise<{ ok: boolean; user?: User; error?: string }>,
    logout(): Promise<void>,
    oauth(provider: "google" | "apple")
      : Promise<{ ok: boolean; error?: string; user?: User }>,
    onLoggedOut(cb: (p: { reason: string; error?: string }) => void): () => void,
  },
  devices: {
    list(): Promise<Device[]>,
    register(payload: { label?: string; device_class: string;
                        consents?: Record<string, unknown>;
                        capabilities?: Record<string, unknown> }): Promise<Device>,
    decommission(id: string): Promise<void>,
    benchmark(id: string): Promise<Device>,            // re-runs the local bench
    current(): Promise<string | null>,                 // device id used by the agent
    setCurrent(id: string | null): Promise<void>,
  },
  agent: {
    status(): Promise<AgentStatus>,                    // {running, deviceId, lastTick, ...}
    start(deviceId?: string): Promise<void>,
    stop(): Promise<void>,
    onEvent(cb: (p: { type: string; status?: unknown }) => void): () => void,
  },
  benchmark: {
    onProgress(cb: (p: { phase: string; pct: number; detail?: string }) => void): () => void,
  },
  system: { snapshot(): Promise<SystemInfo> },          // CPU, RAM, OS, batt, etc.
  payouts: { request(): Promise<Payout> },
  dashboard: { fetch(): Promise<DashboardSnapshot> },
  apiCall(opts: { method?: string; path: string; body?: unknown }): Promise<unknown>,
  lan: {
    scan(): Promise<ScanSummary>,
    onScanProgress(cb: (e: unknown) => void): () => void,
    claimRequest(p: { lan_fingerprint: string; label?: string;
                      gateway_mac?: string; advertised_subnet?: string }): Promise<unknown>,
    claimVerify(p: { lan_fingerprint: string; otp: string }): Promise<unknown>,
    claimList(): Promise<unknown[]>,
    pairAll(opts: {
      devices: Array<{ ip: string; mac: string; hostname: string | null;
                       vendor: string; device_class: string; label: string;
                       randomized_mac: boolean; lan_fingerprint: string }>;
      lanFingerprint: string;
      skipRandomized?: boolean;
      skipRouter?: boolean;
    }): Promise<unknown>,
    onPairProgress(cb: (e: unknown) => void): () => void,
  },
  phoneAgent: { status(): Promise<unknown>, activations(): Promise<unknown> },
  android: {
    status(): Promise<unknown>,
    discover(opts?: { window_seconds?: number }): Promise<unknown>,
    discoverResults(): Promise<unknown>,
    enroll(p: { ip: string; port: number;
                pairing_kind: "tls_pair" | "tls_connect" | "legacy_connect";
                pin?: string | null; label?: string | null }): Promise<unknown>,
    enrollMany(p: { offers: Array<…> }): Promise<unknown>,
    addFriend(p: { ip?: string; mac?: string; label?: string }): Promise<unknown>,
    vetoIp(ip: string): Promise<unknown>,
  },
}
```

IPC channel names (these are the strings the main process must register
with `ipcMain.handle(...)` and `webContents.send(...)`):

```
"config:get" / "config:set"
"auth:state" / "auth:login" / "auth:register" / "auth:logout" / "auth:oauth"
"auth:logged-out"                                  ← main → renderer broadcast
"api:call"
"device:list" / "device:register" / "device:decommission"
"device:benchmark" / "device:current" / "device:setCurrent"
"agent:status" / "agent:start" / "agent:stop"
"agent:event"                                      ← main → renderer broadcast
"system:info"
"earnings:history"
"payout:request"
"lan:scan" / "lan:scan:progress"
"lan:claim:request" / "lan:claim:verify" / "lan:claim:list"
"lan:pair-all" / "lan:pair:progress"
"phone-agent:status" / "phone-agent:activations"
"android:status" / "android:discover" / "android:discover:results"
"android:enroll"  / "android:enroll-many"
"android:friend:add" / "android:friend:veto"
"benchmark:progress"                               ← main → renderer broadcast
```

### 2.5 Agent loop (consumer-only, in main process)

While `agent.start()` is on:

1. Read current device id from electron-store.
2. Every `BENCH_INTERVAL_MS` (12 h) → re-benchmark the host and `POST /devices/{id}/benchmark`.
3. Every `HEARTBEAT_INTERVAL_MS` (15 s):
   * sample CPU/RAM/temp/battery,
   * `POST /v1/agent/heartbeat`,
   * `POST /v1/economics/should-work` — if `should_work=false`, sleep.
4. Every `WORK_POLL_INTERVAL_MS` (4 s) when working is allowed:
   * `POST /v1/agent/work/claim` → workunit or 204,
   * dispatch into a `worker_threads` pool (`worker-pool.ts`) running
     `hash-worker.ts` (or a stub for non-hash workloads),
   * `POST /v1/agent/work/submit` with the result.
5. Reconnect with exponential backoff on network errors
   (`RECONNECT_BASE_MS`=1500, `RECONNECT_MAX_MS`=30000).

`agent:event` broadcasts `{type: "tick" | "workunit:start" | "workunit:done" | "error"; status: AgentStatus}`
so the renderer can render live state on the dashboard.

### 2.6 Persistent store (electron-store)

File: `<userData>/electromesh-consumer.json`. Keys used:

```ts
{
  apiBase: string,
  userToken: string | null,
  refreshToken: string | null,
  currentDeviceId: string | null,
  preferences: { theme?: "dark" | "light" | "ivory", autostart?: boolean, ... },
  deviceTokens: Record<deviceId, string>,
}
```

### 2.7 Tray

* On `app.whenReady`: build `Tray` with `build/icon.ico` and a context menu
  `[Open dashboard, Start/Stop agent, Settings, Quit]`.
* Single instance lock: second launch focuses the existing window.
* `app.on("window-all-closed")` does **not** quit — the tray keeps running.

---

## 3. Enterprise app — feature spec

### 3.1 What the app is

A desktop dashboard for businesses that buy compute on the conet
marketplace. They paste an enterprise API key (no email/password), browse
clusters, build a cart, submit jobs (hashcrack wizard or raw manifest),
watch workunits stream in, and manage their API keys + balance.

### 3.2 Screens / routes

| Route          | Purpose                                                                  |
| -------------- | ------------------------------------------------------------------------ |
| `/login`       | Paste API key + (optional) API base URL → "Connect".                     |
| `/`            | Overview — balance, active jobs, recent workunits, monthly spend.        |
| `/marketplace` | Search clusters by region / kind / min cores / max price; add to cart.   |
| `/jobs/new`    | Wizard: pick workload kind (`hashcrack.range`, `fhe.share`, …) → submit. |
| `/jobs`        | Job list with status, cost, completion %.                                |
| `/jobs/:id`    | Job detail: workunits table, live status, cancel, finalize.              |
| `/api-keys`    | Create / revoke API keys with scopes (`jobs.submit`, `jobs.read`, …).    |
| `/settings`    | API base URL, theme, disconnect.                                         |

### 3.3 Backend endpoints the enterprise calls

Auth: there's no `/login` endpoint — the renderer simply validates an
API key by calling `GET /v1/enterprise/me` with `X-API-Key: ...`. 200 ⇒
connected.

* `GET    /v1/enterprise/me`
* `GET    /v1/enterprise/me/stats`         → overview KPIs
* `POST   /v1/enterprise/me/api-keys`      `{label, scopes, expires_in_days?}` → `{api_key}` once
* `GET    /v1/enterprise/me/api-keys`
* `DELETE /v1/enterprise/me/api-keys/{id}`
* `POST   /v1/marketplace/search`          `{region?, kind?, min_cores?, max_price_usd_hr?, page?}`
* `POST   /v1/marketplace/quote`           `{cluster_ids: string[], hours: number}`
* `GET    /v1/clusters` / `GET /v1/clusters/{id}`
* `POST   /v1/jobs`                        `{kind, manifest, cluster_ids, max_cost_usd}` → JobDetail
* `GET    /v1/jobs` / `GET /v1/jobs/{id}` / `GET /v1/jobs/{id}/workunits`
* `POST   /v1/jobs/{id}/cancel` / `POST /v1/jobs/{id}/finalize`
* `GET    /v1/billing/balance` / `POST /v1/billing/topup`
* `GET    /v1/billing/invoices` / `GET /v1/billing/charges`

### 3.4 IPC surface

```ts
window.electromesh = {
  config: { get(), set({ apiBase? }) },
  auth: {
    state(): Promise<{ connected: boolean; enterprise?: Enterprise; error?: string }>,
    connect({ apiBase?: string, apiKey: string }): Promise<{ ok: boolean; enterprise?: Enterprise; error?: string }>,
    disconnect(): Promise<void>,
    onLoggedOut(cb): () => void,
  },
  stats: { fetch(): Promise<EnterpriseStats> },
  marketplace: {
    search(filter: Record<string, unknown>): Promise<MarketplacePage>,
    quote({ cluster_ids, hours }): Promise<Quote[]>,
  },
  jobs: {
    list(limit?: number): Promise<JobPublic[]>,
    get(id): Promise<JobDetail>,
    workunits(id): Promise<WorkUnitPublic[]>,
    submit(payload): Promise<JobDetail>,
    cancel(id, reason?): Promise<JobPublic>,
    finalize(id): Promise<JobPublic>,
  },
  apiKeys: {
    list(): Promise<ApiKeyPublic[]>,
    create({ label, scopes, expires_in_days? }): Promise<ApiKeyCreated>,  // .api_key only returned once
    revoke(id): Promise<void>,
  },
  apiCall(opts): Promise<unknown>,
}
```

IPC channels:

```
"config:get" / "config:set"
"auth:state" / "auth:connect" / "auth:disconnect" / "auth:logged-out"
"api:call"
"stats:fetch"
"marketplace:search" / "marketplace:quote"
"jobs:list" / "jobs:get" / "jobs:workunits"
"jobs:submit" / "jobs:cancel" / "jobs:finalize"
"apiKeys:list" / "apiKeys:create" / "apiKeys:revoke"
```

### 3.5 Persistent store

File: `<userData>/electromesh-enterprise.json`.

```ts
{
  apiBase: string,
  apiKey: string | null,           // pasted enterprise key
  preferences: { theme?, ... },
}
```

The API key never leaves the main process — the renderer only sees
`auth.state()` shape (`{connected, enterprise}`). The `api:call` IPC
attaches the `X-API-Key` header in the main process before issuing the
request via `electron.net.request`.

---

## 4. Design system (already in `design/`)

* `tokens.css` — three themes (dark default, light, ivory). Single brand
  accent: `--signal: #B6FF1A` (Voltage Lime). Type scale `--t-2xs … --t-6xl`.
  Tracking `--tr-tight / --tr-tightest / --tr-micro`. Mono font:
  `Berkeley Mono → JetBrains Mono → SF Mono → Menlo → Consolas`.
* `base.css` — resets, body grain, `:focus-visible` halos.
* `primitives.css` — `.em-btn / .em-btn-primary / .em-card / .em-input /
  .em-label / .em-divider / .em-pill / .em-h-display / .em-link / ...`.
* Renderer imports them via:

  ```css
  @import "../../../../design/tokens.css";
  @import "../../../../design/fonts/fonts.css";
  @import "../../../../design/base.css";
  @import "../../../../design/primitives.css";
  ```

The previous renderer also ships a hand-written tailwind-shaped utility
sheet (no Tailwind dependency); when rebuilding, either reintroduce
Tailwind+PostCSS *or* stick to plain `em-*` primitives + plain CSS — but
**do not** mix arbitrary `text-[44px]` / `lg:grid-cols-[1fr_1.4fr]` style
classes unless the supporting CSS exists.

---

## 5. Build / run

```bash
# Backend (separate terminal, leave running)
docker compose up -d
curl http://localhost:8080/healthz   # → {"status":"ok"}

# Consumer
cd electromesh-consumer
npm install
npm run dev         # electron-vite dev

# Enterprise
cd electromesh-enterprise
npm install
npm run dev
```

Distributables (per app):

```bash
npm run build:win   # → release/*-Setup.exe (NSIS)
npm run build:mac   # → release/*-arm64.dmg
```

---

## 6. Environment variables

| Var                                | Default                   | Used by                          |
| ---------------------------------- | ------------------------- | -------------------------------- |
| `EM_API_BASE`                      | `http://localhost:8080`   | both Electron apps' main process |
| `EM_WS_BASE`                       | derived from `EM_API_BASE`| consumer agent live channel      |
| Backend secrets (`EM_JWT_SECRET`, `EM_DATABASE_URL`, `EM_REDIS_URL`, `EM_STRIPE_*`, `EM_SENTRY_DSN`) | see `backend/app/config.py` and `backend/FLY_DEPLOYMENT.md` |

---

## 7. Reference points when rebuilding

* Backend route handlers: `backend/app/api/v1/*.py` (one file per resource).
* Backend pydantic schemas (request/response shapes): `backend/app/schemas/`.
* Backend models / migrations: `backend/app/db/models/` + `backend/alembic/`.
* Old preload contracts (for IPC channel names + signatures) were at
  `electromesh-{consumer,enterprise}/src/preload/index.ts` — recover from
  git history (commit `0ba636d`) if needed.
* Old design — split-pane login/register **was scrapped**; new direction is
  single-pane, form-only, centered on the dark page background. No marketing
  hero in the auth surfaces.
