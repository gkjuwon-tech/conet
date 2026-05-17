# ElectroMesh — Local end-to-end demo

This walks you from a clean machine to **submitting a real hashcrack job and
watching your own PC solve it**, on your home WiFi. No mocks, no stubs.

The minimum viable footprint:
- 1 backend (Postgres + Redis + FastAPI) — provided as `docker-compose`
- 1 CLI (`electromesh-cli`) running as user/agent and as enterprise

> The docker-compose ships demo-friendly env: `EM_BUNDLING_SIZE=1` and
> `EM_WORKUNIT_REDUNDANCY=1`, so a single device is enough to bundle a
> cluster and solve a job.

---

## 0 · Requirements

- **Docker Desktop** (or compatible) running
- **Node.js ≥ 20** (`node --version`)
- A few hundred MB of disk

Everything below is run from the `electromesh/` repo root.

---

## 1 · Boot the backend

```powershell
docker compose up -d --build
```

Wait until you see `[backend] starting uvicorn...` in `docker compose logs -f backend`.

The first run also runs `python -m scripts.bootstrap`, which prints something like:

```
==============================================================
[bootstrap] DEMO ENTERPRISE PROVISIONED
  slug        : demo
  enterprise  : 01HXX...
  api_key     : em_live_abc_<looong-secret>
  scopes      : admin.*, jobs.submit, jobs.read, jobs.cancel, marketplace.read
==============================================================
```

> Copy that `api_key` — it appears once. (The bootstrap also drops a copy
> into `backend/.bootstrap.json` inside the container.)

Sanity check from the host:

```powershell
curl http://localhost:8080/healthz
# {"status":"ok","service":"electromesh-api"}
```

---

## 2 · Install the CLI

```powershell
cd electromesh-cli
npm install
npm link            # makes `em` available globally; or use `node bin/em.mjs`
```

Tell it where the backend is (the default `http://localhost:8080` is fine):

```powershell
em config set-api http://localhost:8080
em config ping
# ✓ ok {"status":"ok",...}
```

---

## 3 · The 1-shot demo

The fastest path. This single command does **all** of:

1. Connect with the enterprise API key
2. Register a new user (or reuse one)
3. Pair this PC as a device
4. Run a real benchmark
5. Trigger the FCFS bundler to form a 1-device cluster
6. Hash a known plaintext and submit a `hashcrack.range` job for it
7. Start the agent and watch it solve

```powershell
em demo --key em_live_abc_<your-key> --text "hi42" --charset alnum
```

You should see something like:

```
ElectroMesh end-to-end demo

▸ verify backend
  {"status":"ok","service":"electromesh-api"}
▸ connect enterprise
  tenant=demo (01HXX…)
▸ ensure user
  registered demo-user@electromesh.local
▸ pair this machine
  Intel(R) Core(TM) i7-12700H · 14c @ 2.7 GHz · 32768 MB · win32
  device id=01HZZ…  status=pending_attestation
▸ benchmark
  cpu      100%
  hash     100%
  argon    100%
  network  100%
  status=idle h100eq=0.000123 hash=4.2MH/s
▸ trigger FCFS bundler (cluster forms)
  bundled=1 retired=0
▸ compute target hash from plaintext
  sha256("hi42") = 1b4e9a5b2…
▸ submit hashcrack job
  job job_01HZZ… workunits=1
▸ starting agent
  • attesting…
  ✓ attested
  ▸ wu_01HZZ… len=4, range=0..14776336
▸ waiting for job to terminate
  succeeded   [████████████████████████] 1/1
  ✓ wu_01HZZ… HIT 2641ms consensus✓  → hi42

Result
  status   : succeeded
  spent    : $0.0021
  paid out : $0.0017
  workunits: 1/1 (0 failed)
  recovered: hi42 ✓ matches plaintext
```

Done. Your PC just solved its own demo job.

---

## 4 · The same flow, broken into steps

If you want to see the bones:

```powershell
# As enterprise (stores the key locally, encrypted lightly)
em ent connect em_live_abc_<your-key>

# As a user
em register --email me@example.com --password 0123456789abcd
em config show              # confirm everything is wired

# Pair this machine — runs system probe + benchmark + agent token issue
em device pair --label "MyPC" --max-cpu 25
em device list

# Form a cluster (only required because we run with bundling_size=1 in dev)
em admin bundle             # bundled=1

# Submit a real hashcrack job
em job plain --text "hi42" --algo sha256 --charset alnum

# In another terminal, watch the agent grind it out
em agent run
```

The agent prints lines like:

```
• attesting…
✓ attested
▸ wu_01HZZ… len=4, range=0..14776336
✓ wu_01HZZ… HIT 2641ms consensus✓  → hi42
```

---

## 5 · Anatomy of what just happened

| Step                      | Endpoint hit                                     | Side effect |
| ------------------------- | ------------------------------------------------ | ----------- |
| `em register`             | `POST /v1/users/register` + `POST /v1/users/login` | new user, JWT in `~/.electromesh/state.json` |
| `em device pair`          | `POST /v1/devices/register` → `POST /v1/devices/{id}/issue-token` → `POST /v1/devices/{id}/benchmark` | device row, agent token, h100-equivalent score |
| `em admin bundle`         | `POST /v1/admin/run/bundler` | virtual cluster of 1 device, priced |
| `em job plain`            | `POST /v1/jobs` | hashcrack manifest validated by `services.isolation`, chunked by `crypto.chunker`, leases the cluster |
| `em agent run` (claim)    | `POST /v1/agent/work/claim` | agent grabs `range_lo..range_hi` chunk |
| (worker thread)           | local `worker_threads`        | tries each candidate against `target_hash`; never sees plaintext-as-input |
| `em agent run` (submit)   | `POST /v1/agent/work/submit` | result + sha256 of result → backend evaluates consensus |
| (consensus achieved)      | _internal_                    | workunit marked `succeeded` |
| watcher loop              | `GET /v1/jobs/{id}` | progress until terminal |

---

## 6 · Try harder targets

```powershell
# 5-character lowercase password
em job plain --text "yolo!" --charset all --min 5 --max 5

# A leaked SHA-256 you have lying around
em job hash --target d2d2... --algo sha256 --charset lower --min 4 --max 7 --watch

# Watch what the agent is doing live
em -v agent run     # -v prints per-chunk progress

# Pause / resume earning
Ctrl-C              # stop the agent
em agent run        # back online
```

---

## 7 · Cleaning up

```powershell
# Stop the agent (Ctrl-C) and the backend
docker compose down

# Wipe local CLI state (does NOT touch the backend)
em config reset

# Nuke the backend's data too
docker compose down -v
```

---

## 8 · Troubleshooting

**`✗ workunit_rejected: no workunits could be derived from manifest`** — your
charset/length range produced zero candidates. Bump `--max` or widen
`--charset`.

**`✗ insufficient_capacity: no clusters meet target capacity`** — you forgot
`em admin bundle`, or your device's `h100_equivalent` is below the bundling
floor (run a real benchmark, not `--skip-benchmark`).

**Job sits in `consensus_pending`** — you submitted with `--redundancy 2+`
but only have one device. Lower `--redundancy 1` or pair another machine.

**`✗ attestation failed`** — the PoW miner ran longer than the difficulty
budget. Try again; difficulty defaults to 18 bits, which finishes in a couple
of seconds on any laptop.
