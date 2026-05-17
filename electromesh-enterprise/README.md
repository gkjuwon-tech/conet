# ElectroMesh Enterprise

Desktop console for tenants who buy compute on ElectroMesh. Pure consumer of
the backend's `/v1/enterprise`, `/v1/marketplace`, `/v1/jobs` APIs. Auth is
API-key based — paste an `em_live_…` key on first launch.

## Layout

```
src/main/
  index.ts          App + window
  api-client.ts     net.request client (X-Api-Key header)
  store.ts          safeStorage-encrypted state (api key, base url)
  ipc.ts            ipcMain handlers — auth, marketplace, jobs, api keys, stats
  constants.ts      IPC channel names

src/preload/index.ts        typed contextBridge

src/renderer/
  pages/Login.tsx           API base + key form
  pages/Overview.tsx        Active jobs / 30d spend / success rate
  pages/Marketplace.tsx     Cluster grid w/ filters + cart drawer
  pages/Jobs.tsx            All-time job list w/ status pills
  pages/NewJob.tsx          Wizard: kind → params → cart → submit
  pages/JobDetail.tsx       Workunit table + manifest + finalize/cancel
  pages/ApiKeys.tsx         Create/revoke (shows secret once)
  pages/Settings.tsx        API base override
  state/auth.ts             Zustand auth store
  state/cart.ts             Cluster cart
```

## Run dev

```
pnpm install
pnpm dev
```

## Build releases

```
pnpm build:win   # → release/ElectroMesh-Enterprise-0.1.0-Setup.exe
pnpm build:mac   # → release/ElectroMesh-Enterprise-0.1.0-arm64.dmg
```

## Auth

- The first screen asks for an enterprise **API base URL** and an **API key**.
- The API key is stored encrypted via Electron `safeStorage`.
- All subsequent API calls send `X-Api-Key: <key>`.

To mint a key: log in once with the JS API and call
`POST /v1/enterprise/me/api-keys` (admin endpoint), or have your tenant admin
create one via `POST /v1/enterprise` then `/me/api-keys`.

## Submitting a job

1. Marketplace → filter clusters → add to cart with hours.
2. New job → choose kind (currently `hashcrack.range` / `hashcrack.dict`
   wired in the wizard; other kinds accept a raw manifest via the API).
3. Set isolation policy (defaults: forbid plaintext, chunk-only,
   AES-GCM, 2× redundancy at 66% consensus).
4. Submit → backend chunks the keyspace, leases the chosen clusters, and
   dispatches workunits to consumer agents.
5. Job detail page polls every 5s for live workunit status, redundancy
   counts, and consensus scores.
