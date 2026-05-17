# ElectroMesh Consumer

The desktop agent that runs on a participant's machine. Pairs the host as a
device, benchmarks it, and runs background workloads (currently SHA/MD5/NTLM
range hashcrack) when idle. All earnings flow into the user's wallet.

## What lives where

```
src/main/                 Electron main process — the actual agent
  index.ts                App lifecycle + window
  api-client.ts           electron net.request wrapper for the backend
  store.ts                Encrypted persistent state (safeStorage)
  system-info.ts          Hardware + LAN fingerprint detection
  benchmark.ts            CPU GFLOPS / SHA-256 / scrypt / network probes
  worker-pool.ts          worker_threads pool for hash workloads
  hash-worker.ts          Per-workunit ranged hash brute force
  agent.ts                Heartbeat + claim + submit loop
  tray.ts                 System tray menu
  ipc.ts                  All ipcMain handlers
  constants.ts            IPC channel names + intervals

src/preload/index.ts      contextBridge — exposes a typed `window.electromesh`

src/renderer/             React + Tailwind UI
  pages/Login.tsx         Email/password against /v1/users/login
  pages/Register.tsx      /v1/users/register + ToS gate
  pages/Onboarding.tsx    Post-signup welcome
  pages/Dashboard.tsx     Earnings + live workunits + agent controls
  pages/Devices.tsx       Card list of all paired devices
  pages/PairDevice.tsx    Detect → consents → register → benchmark → live
  pages/DeviceDetail.tsx  Hardware breakdown, consents JSON, live work
  pages/Earnings.tsx      Payout ledger
  pages/Payouts.tsx       Request payout, view history
  pages/Settings.tsx      API base, autostart, tray, GPU, night-only
```

## Run dev

```
pnpm install
pnpm dev   # launches electron + vite
```

The app expects a backend at `http://localhost:8080` by default. Override via
`EM_API_BASE` env var, the Settings page, or by editing the API URL on Login.

## Build releases

```
pnpm build:win   # → release/ElectroMesh-0.1.0-Setup.exe
pnpm build:mac   # → release/ElectroMesh-0.1.0-arm64.dmg + x64
```

`build:all` builds both Windows and macOS targets. Provide signing identities
via standard `electron-builder` env vars (`CSC_LINK`, `APPLE_ID` etc.) for
notarized release builds.

## How the agent flows

1. User signs in → token stored in encrypted `userData/electromesh-consumer.json`.
2. PairDevice page: detect hardware (`systeminformation`), call
   `/v1/devices/register`, issue a device token via
   `/v1/devices/{id}/issue-token`, run benchmark, submit via
   `/v1/devices/{id}/benchmark`.
3. `ConsumerAgent.start(deviceId)`:
   - Mines a PoW attestation (or RSA sig if a key was registered) and posts to
     `/v1/agent/attest/verify`.
   - Heartbeat loop: `readLiveTelemetry` → `/v1/agent/heartbeat` every 15s.
   - Claim loop every 4s: `POST /v1/agent/work/claim`. For each unit it spawns
     a `worker_thread` (`hash-worker.ts`) bound to that workunit's range.
   - On worker `result`/`error` it posts `/v1/agent/work/submit` with a
     stable JSON-canonicalized SHA-256 hash of the result.
4. Tray menu shows running state; closing the window minimizes to tray.

The agent never receives plaintext or full keys — only `range_lo`/`range_hi`
bounds plus the target hash.
