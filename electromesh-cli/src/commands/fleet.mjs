// em fleet — spin up a real, persistent fleet of virtual devices.
//
// Each entry in the catalog (16 in the default deck) becomes a Worker thread
// running its own pairing handshake, heartbeat loop, and claim/work/submit
// loop. From the backend's perspective, this is indistinguishable from
// 16 separate phones / TVs / NAS / fridges showing up on the same LAN at
// roughly the same time. The orchestrator running in the CLI's main thread:
//
//   1. Verifies the user is logged in + a LAN claim exists.
//   2. Spawns N Workers (one per profile_key, optionally with a multiplier).
//   3. Triggers the bundler periodically so freshly-paired devices get
//      pulled into single-device clusters and become lease-eligible.
//   4. Optionally submits a fleet job and watches devices race through it.
//   5. Renders a tiny live dashboard so you can watch which device just
//      claimed/finished work, hit/miss, and lifetime stats.
//
//   $ em fleet up
//   $ em fleet up --types phone,tv,fridge
//   $ em fleet up --auto-bench --auto-bundle --auto-job

import { Worker } from "node:worker_threads";
import path from "node:path";
import { fileURLToPath } from "node:url";
import crypto from "node:crypto";
import pc from "picocolors";
import { store } from "../lib/store.mjs";
import { api } from "../lib/api.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WORKER_PATH = path.resolve(__dirname, "..", "workers", "virtual-device.mjs");

const ICON = {
  phone: "📱",
  tablet: "📲",
  smart_tv: "📺",
  console: "🎮",
  desktop: "🖥️",
  laptop: "💻",
  nas: "💾",
  router: "📡",
  smart_bulb: "💡",
  smart_plug: "🔌",
  microwave: "🔥",
  fridge: "🧊",
  washer: "🌀",
  dryer: "🧺",
  other_iot: "🤖",
};

const DASH_INTERVAL_MS = 1500;
const BUNDLE_INTERVAL_MS = 5000;

function fmtNum(n) {
  return n.toLocaleString();
}

function shortId(id) {
  return id ? id.slice(0, 14) + "…" : "—";
}

class FleetOrchestrator {
  constructor({ profiles, lanFp, userToken, backend, autoJob, autoBundle, watch }) {
    this.profiles = profiles;
    this.lanFp = lanFp;
    this.userToken = userToken;
    this.backend = backend;
    this.autoJob = autoJob;
    this.autoBundle = autoBundle;
    this.watch = watch;
    this.workers = new Map(); // profileKey → { worker, state }
    this.startedAt = Date.now();
    this.lastDash = 0;
    this.bundleTimer = null;
  }

  async start() {
    process.stdout.write(
      `${pc.bold(`⚡ conet · virtual fleet`)}  ${pc.dim(
        `${this.profiles.length} devices · backend=${this.backend}`
      )}\n\n`
    );

    for (const profile of this.profiles) {
      this.spawnDevice(profile);
    }

    if (this.autoBundle) {
      this.bundleTimer = setInterval(() => this.triggerBundle().catch(() => {}), BUNDLE_INTERVAL_MS);
      // Trigger right away too
      setTimeout(() => this.triggerBundle().catch(() => {}), 2500);
    }

    process.on("SIGINT", () => this.shutdown(0));
    process.on("SIGTERM", () => this.shutdown(0));

    setInterval(() => this.renderDashboard(), DASH_INTERVAL_MS);

    if (this.autoJob) {
      // Wait until the fleet is mostly paired, then submit the demo job
      setTimeout(() => this.submitFleetJob().catch((e) => this.warn(`autoJob: ${e.message}`)), 12000);
    }
  }

  spawnDevice(profile) {
    const label = `vfleet-${profile.key}-${crypto.randomBytes(2).toString("hex")}`;
    const w = new Worker(WORKER_PATH, {
      workerData: {
        profileKey: profile.key,
        deviceClass: profile.device_class,
        pairingMethod: profile.pairing_method,
        label,
        lanFp: this.lanFp,
        userToken: this.userToken,
        backend: this.backend,
      },
    });
    const state = {
      profile,
      label,
      phase: "spawning",
      device_id: null,
      device_handle: null,
      device_class: profile.device_class,
      h100_equivalent: 0,
      claims: 0,
      completed: 0,
      hits: 0,
      failed: 0,
      lastEventAt: Date.now(),
      lastEvent: "",
    };
    this.workers.set(profile.key, { worker: w, state });

    w.on("message", (msg) => this.handleMessage(profile.key, msg));
    w.on("error", (err) => {
      state.phase = "error";
      state.lastEvent = String(err.message || err).slice(0, 60);
      state.lastEventAt = Date.now();
    });
    w.on("exit", (code) => {
      if (state.phase !== "stopped") {
        state.phase = code === 0 ? "stopped" : "crashed";
        state.lastEvent = `exit(${code})`;
        state.lastEventAt = Date.now();
      }
    });
  }

  handleMessage(profileKey, msg) {
    const entry = this.workers.get(profileKey);
    if (!entry) return;
    const s = entry.state;
    s.lastEventAt = Date.now();
    switch (msg.type) {
      case "status":
        s.phase = msg.phase;
        if (msg.method) s.lastEvent = `method=${msg.method}`;
        break;
      case "paired":
        s.phase = "idle";
        s.device_id = msg.device_id;
        s.device_handle = msg.device_handle;
        s.h100_equivalent = msg.h100_equivalent ?? 0;
        s.lastEvent = `paired h100=${(msg.h100_equivalent ?? 0).toFixed(4)}`;
        break;
      case "work_claimed":
        s.phase = "working";
        s.claims++;
        s.lastEvent = `claim ${shortId(msg.workunit_id)}`;
        break;
      case "work_done":
        s.phase = "idle";
        s.completed = msg.completed;
        s.hits = msg.hits;
        s.lastEvent = msg.found
          ? `${pc.green("HIT")} "${msg.found}" ${msg.runtime_ms}ms`
          : `miss ${fmtNum(msg.scanned)} ${msg.runtime_ms}ms`;
        break;
      case "work_failed":
        s.failed++;
        s.lastEvent = `fail ${shortId(msg.workunit_id)}: ${msg.msg}`;
        break;
      case "warn":
        s.lastEvent = `warn: ${msg.msg}`;
        break;
      case "error":
        s.phase = "error";
        s.lastEvent = `err: ${msg.msg}`;
        break;
      case "stopped":
        s.phase = "stopped";
        break;
    }
  }

  async triggerBundle() {
    try {
      // _bundle requires admin — we use the magic em_live_admin key.
      const res = await fetch(this.backend + "/v1/clusters/_bundle", {
        method: "POST",
        headers: { "X-Api-Key": "em_live_admin" },
      });
      if (res.ok) {
        const arr = await res.json();
        if (arr.length) this.warn(`bundler tick → ${arr.length} new cluster(s)`);
      }
    } catch (e) {
      this.warn(`bundle: ${e.message}`);
    }
  }

  async submitFleetJob() {
    const state = await store.get();
    const entKey = state.enterprise?.apiKey;
    if (!entKey) {
      this.warn("no enterprise key — skip auto-job");
      return;
    }
    const text = "yolo";
    const target = crypto.createHash("sha256").update(text).digest("hex");
    const charset = "abcdefghijklmnopqrstuvwxyz";
    const length = text.length;
    const total = Math.pow(charset.length, length); // 26^4 = 456,976
    // Aim for ~3-4 workunits per device so every Worker gets at least one
    // claim and the dispatcher's `redundancy=2` consensus also has spare
    // attempts to choose from.
    const targetUnits = this.profiles.length * 3;
    const chunkSize = Math.max(10000, Math.floor(total / targetUnits));
    const body = {
      kind: "hashcrack.range",
      title: `fleet proof — recover "${text}"`,
      target_cluster_count: this.profiles.length,
      target_h100_equivalent: 0.0001,
      max_budget_cents: 1000,
      max_runtime_seconds: 600,
      hashcrack_range: {
        algorithm: "sha256",
        target_hash: target,
        charset,
        min_length: length,
        max_length: length,
        range_lo: 0,
        range_hi: total,
        chunk_size: chunkSize,
      },
    };
    process.stdout.write(
      pc.bold(
        `\n${pc.cyan("◆")} fleet job: recover "${text}" via sha256 across ${this.profiles.length} virtual devices\n`
      )
    );
    process.stdout.write(
      pc.dim(`  target=${target.slice(0, 24)}…  range=0..${fmtNum(total)}  chunk=${fmtNum(chunkSize)}\n\n`)
    );
    const res = await fetch(this.backend + "/v1/jobs", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Api-Key": entKey },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const txt = await res.text();
      this.warn(`autoJob: ${res.status} ${txt.slice(0, 200)}`);
      return;
    }
    const job = await res.json();
    this.jobId = job.id;
    this.jobHandle = job.handle;
    this.jobTotal = job.workunit_total;
  }

  warn(msg) {
    process.stderr.write(pc.dim(`  ${msg}\n`));
  }

  renderDashboard() {
    const now = Date.now();
    if (now - this.lastDash < DASH_INTERVAL_MS) return;
    this.lastDash = now;

    const lines = [];
    const aggregate = { paired: 0, working: 0, idle: 0, error: 0, claims: 0, completed: 0, hits: 0 };
    for (const { state: s } of this.workers.values()) {
      if (s.device_id) aggregate.paired++;
      if (s.phase === "working") aggregate.working++;
      else if (s.phase === "idle") aggregate.idle++;
      else if (s.phase === "error" || s.phase === "crashed") aggregate.error++;
      aggregate.claims += s.claims;
      aggregate.completed += s.completed;
      aggregate.hits += s.hits;
    }

    const elapsed = ((now - this.startedAt) / 1000).toFixed(0);
    const headerLine = pc.bold(
      `┌─ fleet  ${elapsed}s  ─  paired ${aggregate.paired}/${this.workers.size}  ` +
        `working ${aggregate.working}  idle ${aggregate.idle}  err ${aggregate.error}  ─  ` +
        `claims ${aggregate.claims}  done ${aggregate.completed}  hits ${aggregate.hits}`
    );
    lines.push(headerLine);

    const rows = [...this.workers.values()].sort(
      (a, b) => a.state.profile.key.localeCompare(b.state.profile.key)
    );
    for (const { state: s } of rows) {
      const icon = ICON[s.device_class] || "  ";
      const name = (s.profile.display_name || s.profile.key).padEnd(10);
      const phase = s.phase.padEnd(8);
      const phaseColor = phase.includes("working")
        ? pc.cyan(phase)
        : phase.includes("idle")
          ? pc.green(phase)
          : phase.includes("paired") || phase.includes("pairing")
            ? pc.yellow(phase)
            : phase.includes("error") || phase.includes("crashed")
              ? pc.red(phase)
              : pc.dim(phase);
      const id = s.device_id ? pc.dim(shortId(s.device_id)) : pc.dim("…").padEnd(15);
      const counts = pc.dim(`c${s.claims} d${s.completed} h${s.hits} f${s.failed}`);
      const lastEv = pc.dim(s.lastEvent.slice(0, 56));
      lines.push(`│ ${icon} ${name} ${phaseColor} ${id.padEnd(20)} ${counts.padEnd(20)} ${lastEv}`);
    }
    lines.push(pc.bold(`└──`));

    // Render: clear and redraw the dashboard region. We just print fresh
    // lines each tick; users can scroll back in their terminal to see
    // history. Keep it simple — no ANSI cursor tricks.
    process.stdout.write("\n" + lines.join("\n") + "\n");
  }

  shutdown(code) {
    process.stdout.write(pc.bold("\nshutting down virtual fleet...\n"));
    if (this.bundleTimer) clearInterval(this.bundleTimer);
    for (const { worker } of this.workers.values()) {
      try {
        worker.postMessage({ type: "stop" });
      } catch {
        /* noop */
      }
    }
    setTimeout(() => process.exit(code), 1500);
  }
}

export function registerFleet(program) {
  const cmd = program.command("fleet").description("Spin up a real fleet of virtual devices");

  cmd
    .command("up")
    .description("Spawn one Worker per device profile, run the full agent loop on each")
    .option("--types <list>", "comma-separated profile keys (default: all 16)")
    .option("--no-auto-bundle", "do NOT trigger /clusters/_bundle on a timer")
    .option("--auto-job", "submit a demo hashcrack job and watch the fleet race through it", false)
    .action(async (opts) => {
      const state = await store.get();
      if (!state.userToken) {
        console.error(pc.red("✗ not signed in — run `em login` first"));
        process.exit(1);
      }
      const backend = state.apiBase;

      // 1. Make sure we have a verified LAN claim. If not, run claim flow first.
      let lanFp = await ensureLanClaim(state, backend);

      // 2. Pick profile set
      const catalog = await api.raw({
        method: "GET",
        path: "/v1/pairing/catalog",
      });
      const allProfiles = catalog.profiles;
      const wanted = opts.types
        ? opts.types.split(",").map((s) => s.trim()).filter(Boolean)
        : null;
      const profiles = wanted
        ? allProfiles.filter((p) => wanted.includes(p.key))
        : allProfiles;
      if (!profiles.length) {
        console.error(pc.red("✗ no matching profiles"));
        process.exit(1);
      }

      const orch = new FleetOrchestrator({
        profiles,
        lanFp,
        userToken: state.userToken,
        backend,
        autoJob: !!opts.autoJob,
        autoBundle: opts.autoBundle !== false,
      });
      await orch.start();
    });

  cmd
    .command("status")
    .description("List paired virtual-fleet devices currently registered for this user")
    .action(async () => {
      const state = await store.get();
      if (!state.userToken) {
        console.error(pc.red("✗ not signed in"));
        process.exit(1);
      }
      const devs = await api.raw({
        method: "GET",
        path: "/v1/devices",
        token: state.userToken,
      });
      const fleet = devs.filter((d) => /^vfleet-/.test(d.label || ""));
      if (!fleet.length) {
        console.log(pc.dim("(no virtual-fleet devices found — run `em fleet up`)"));
        return;
      }
      for (const d of fleet) {
        console.log(
          `  ${ICON[d.device_class] || "  "} ${pc.bold(d.label.padEnd(28))} ${d.device_class.padEnd(12)} ${d.status.padEnd(10)} h100=${(d.h100_equivalent || 0).toFixed(4)}  done=${d.workunits_completed}  rev=${d.revenue_cents_lifetime}c`
        );
      }
    });
}

async function ensureLanClaim(state, backend) {
  // Cheap path: list claims, pick the active one's fingerprint.
  try {
    const claims = await api.raw({
      method: "GET",
      path: "/v1/lan-claims",
      token: state.userToken,
    });
    const verified = (Array.isArray(claims) ? claims : claims?.claims || []).find(
      (c) => c.is_active && (c.status === "verified" || c.verified_at)
    );
    if (verified?.lan_fingerprint) return verified.lan_fingerprint;
  } catch {
    /* fall through to claim flow */
  }
  // Otherwise tell the user.
  console.error(
    pc.red("✗ no verified LAN claim — run `em lan claim` first (it sends an OTP to your registered email)")
  );
  process.exit(1);
}
