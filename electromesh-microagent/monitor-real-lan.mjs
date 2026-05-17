// Live monitor for ONLY the real LAN-discovered devices on this user's account.
// Filters out the simulator pool (Living Room TV (Samsung Q90), Synology DS923+, etc).
// Polls /v1/devices every 2s, prints a refreshed table with status + h100eq +
// inflight workunits + last heartbeat.

import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import pc from "picocolors";

const STATE = JSON.parse(
  fs.readFileSync(path.join(os.homedir(), ".electromesh", "state.json"), "utf8")
);
const TOKEN = STATE.userToken;
if (!TOKEN) {
  console.error(pc.red("✗ not logged in"));
  process.exit(1);
}

// Anything starting with these labels is a *simulated* IoT device — exclude.
const SIM_PREFIXES = [
  "Living Room TV ",
  "PlayStation 5 ",
  "Synology ",
  "Smart Fridge ",
  "Edge Router (",
  "Smart Microwave ",
  "Smart Washer ",
  "Smart Dryer ",
  "TestTV",
  "Test TV",
  "Hue Bulb",
  "Yeelight",
  "TP-Link Plug",
  "Aqara Plug",
  "iPad ",
  "Old Pixel ",
  "Roomba ",
  "Apple TV ",
  "Sonos "
];
const isSimulated = (label) =>
  SIM_PREFIXES.some((p) => label?.startsWith(p));

const STATUS_COLOR = {
  idle: pc.cyan,
  leased: pc.green,
  benchmarking: pc.yellow,
  pending_attestation: pc.yellow,
  cooldown: pc.dim,
  decommissioned: pc.dim
};

function clear() {
  process.stdout.write("\x1Bc");
}

async function snapshot() {
  const res = await fetch("http://localhost:8080/v1/devices", {
    headers: { Authorization: `Bearer ${TOKEN}` }
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return await res.json();
}

const ICONS = {
  smart_tv: "📺",
  fridge: "🧊",
  console: "🎮",
  nas: "💾",
  router: "📡",
  microwave: "♨️",
  washer: "🧺",
  dryer: "🌀",
  smart_bulb: "💡",
  smart_plug: "🔌",
  laptop: "💻",
  desktop: "🖥",
  phone: "📱",
  tablet: "📲",
  gpu_rig: "⚡",
  other_iot: "📦"
};

function fmtAge(iso) {
  if (!iso) return pc.dim("never");
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 1500) return pc.green(`${ms}ms`);
  if (ms < 5_000) return pc.green(`${(ms / 1000).toFixed(1)}s`);
  if (ms < 60_000) return pc.yellow(`${(ms / 1000).toFixed(0)}s`);
  if (ms < 3_600_000) return pc.red(`${(ms / 60_000).toFixed(0)}m`);
  return pc.red(`${(ms / 3_600_000).toFixed(0)}h`);
}

let prev = new Map();

async function tick() {
  const all = await snapshot();
  const real = all.filter((d) => !isSimulated(d.label));

  clear();
  process.stdout.write(
    pc.bold(pc.cyan("══════════════════════════════════════════════════════════════════════\n"))
  );
  process.stdout.write(
    pc.bold(`  ElectroMesh — live monitor (real LAN devices only) · ${pc.dim(new Date().toLocaleTimeString())}\n`)
  );
  process.stdout.write(
    pc.dim(`  ${real.length} real devices · simulated pool hidden · refresh 2s\n`)
  );
  process.stdout.write(
    pc.bold(pc.cyan("══════════════════════════════════════════════════════════════════════\n\n"))
  );

  process.stdout.write(
    pc.dim(
      "  STATUS         CLASS         LABEL                                       h100eq      LAST HB\n"
    )
  );
  process.stdout.write(pc.dim("  " + "─".repeat(96) + "\n"));

  for (const d of real) {
    const status = (d.status ?? "?").padEnd(13);
    const cls = (d.device_class ?? "?").padEnd(12);
    const label = (d.label ?? "?").slice(0, 40).padEnd(42);
    const h100 = String(d.h100_equivalent ?? 0).padStart(10);
    const hb = fmtAge(d.last_heartbeat_at);
    const icon = ICONS[d.device_class] ?? "·";
    const color = STATUS_COLOR[d.status] ?? pc.white;

    // diff highlight
    const before = prev.get(d.id);
    const changed =
      !before ||
      before.status !== d.status ||
      before.h100_equivalent !== d.h100_equivalent;

    const arrow = changed ? pc.yellow("→") : " ";

    process.stdout.write(
      `  ${arrow} ${color(status)} ${pc.dim(cls)} ${icon}  ${pc.bold(label)} ${pc.cyan(h100)}    ${hb}\n`
    );
  }

  // tally
  const counts = real.reduce((m, d) => {
    m[d.status] = (m[d.status] ?? 0) + 1;
    return m;
  }, {});
  const sumH100 = real.reduce((s, d) => s + (d.h100_equivalent || 0), 0);
  process.stdout.write(
    `\n  ${pc.dim("totals:")} ${Object.entries(counts)
      .map(([k, v]) => `${(STATUS_COLOR[k] ?? pc.white)(k)}=${v}`)
      .join("  ")}  ${pc.dim("·")}  ${pc.bold("Σh100eq")}=${pc.cyan(sumH100.toFixed(6))}\n`
  );

  prev = new Map(real.map((d) => [d.id, d]));
}

await tick();
setInterval(() => tick().catch((e) => console.error(pc.red(e.message))), 2000);
