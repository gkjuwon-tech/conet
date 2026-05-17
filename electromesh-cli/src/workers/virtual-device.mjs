// virtual-device.mjs — one ElectroMesh device, simulated as a real Worker.
//
// Each instance of this Worker is an INDEPENDENT virtual device. It owns its
// own pairing handshake, its own device JWT, its own heartbeat timer, and its
// own claim/process/submit loop. Sixteen of these running side-by-side IS
// an actual fleet from the backend's perspective — the fact that they happen
// to share a Node process is an implementation detail; the dispatcher,
// bundler, lease manager, and consensus engine treat them as 16 distinct
// peers exactly the same as 16 phones on a real LAN would be.
//
// Each device emulates its catalog pairing method end-to-end:
//   - qr_token   : POST /pairing/start → use returned qr_token in /pairing/complete
//   - local_auth : same flow (TVs would normally be auto-discovered + approved)
//   - fake_dns   : same (consoles auto-redirect to gateway DNS)
//   - docker     : same (NAS launches a docker container that hits /complete)
//   - curl_sh    : same (router runs the printed curl|sh oneliner)
//   - mdns_probe : same (gateway sees the device's mDNS announcement)
//   - pin        : POST /pairing/start → use returned pin in /pairing/complete
//   - otp        : same with otp
//   - instant    : POST /pairing/instant in one shot

import { parentPort, workerData } from "node:worker_threads";
import crypto from "node:crypto";

const {
  profileKey,
  deviceClass,
  pairingMethod,
  label,
  lanFp,
  userToken,
  backend,
  heartbeatMs = 8000,
  claimMs = 3000,
} = workerData;

const HASH_KINDS = new Set(["hashcrack.range", "hashcrack.dict"]);

let deviceId = null;
let deviceHandle = null;
let deviceToken = null;
let stopping = false;
let inflight = 0;
const stats = { paired_at: null, claims: 0, completed: 0, hits: 0, failed: 0, scanned: 0, ms: 0 };

function send(type, extra = {}) {
  parentPort.postMessage({ type, profileKey, deviceId, ...extra });
}

async function api(method, path, body, useDeviceToken = false) {
  const tok = useDeviceToken ? deviceToken : userToken;
  const res = await fetch(backend + path, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(tok ? { Authorization: `Bearer ${tok}` } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const txt = await res.text();
  if (!res.ok) {
    const detail = txt ? txt.slice(0, 200) : "";
    throw new Error(`${method} ${path} → ${res.status} ${detail}`);
  }
  return txt ? JSON.parse(txt) : null;
}

// ---------------------------------------------------------------------------
// Pairing — full V2 handshake per profile method
// ---------------------------------------------------------------------------
async function pair() {
  send("status", { phase: "pairing", method: pairingMethod });

  // Profiles that route through /pairing/instant need no secret exchange — the
  // gateway is asserting "this device is on my LAN, just register it".
  if (pairingMethod === "instant") {
    const r = await api("POST", "/v1/pairing/instant", {
      profile_key: profileKey,
      lan_fingerprint: lanFp,
      label,
    });
    deviceId = r.device.id;
    deviceHandle = r.device.handle;
    deviceToken = r.token;
    return r.device;
  }

  // Everything else opens a session, then completes via the right secret.
  const sess = await api("POST", "/v1/pairing/start", {
    profile_key: profileKey,
    lan_fingerprint: lanFp,
    label,
  });

  const completeBody = {};
  if (sess.method === "pin") {
    if (!sess.pin) throw new Error("pin missing from session");
    completeBody.pin = sess.pin;
  } else if (sess.method === "otp") {
    if (!sess.otp) throw new Error("otp missing from session");
    completeBody.otp = sess.otp;
  } else {
    if (!sess.qr_token) throw new Error("qr_token missing from session");
    completeBody.qr_token = sess.qr_token;
  }

  const r = await api("POST", "/v1/pairing/complete", completeBody);
  deviceId = r.device.id;
  deviceHandle = r.device.handle;
  deviceToken = r.token;
  return r.device;
}

// ---------------------------------------------------------------------------
// Heartbeat — keep last_seen_at fresh so the bundler accepts us
// ---------------------------------------------------------------------------
async function heartbeat() {
  await api(
    "POST",
    "/v1/agent/heartbeat",
    {
      cpu_usage_pct: inflight ? 70 + Math.random() * 20 : 5 + Math.random() * 10,
      gpu_usage_pct: 0,
      ram_usage_pct: 25 + Math.random() * 30,
      temperature_c: 35 + Math.random() * 8,
      download_mbps: 0,
      upload_mbps: 0,
      extras: { agent: "virtual-fleet", profile: profileKey, inflight },
    },
    true
  );
}

// ---------------------------------------------------------------------------
// Claim + process — actually solve hashcrack workunits with native sha256
// ---------------------------------------------------------------------------
function indexToCandidate(charset, length, index) {
  const radix = charset.length;
  const out = new Array(length);
  for (let i = length - 1; i >= 0; i--) {
    out[i] = charset[index % radix];
    index = Math.floor(index / radix);
  }
  return out.join("");
}

function hashCandidate(algo, salt, cand) {
  if (algo === "ntlm") {
    return crypto.createHash("md4").update(Buffer.from(cand, "utf16le")).digest("hex");
  }
  return crypto.createHash(algo).update((salt ?? "") + cand, "utf8").digest("hex");
}

async function processUnit(u) {
  const t0 = Date.now();
  const p = u.payload;
  const target = String(p.target_hash).toLowerCase();
  let found = null;
  const total = p.range_hi - p.range_lo;
  const yieldEvery = 50_000; // keep the heartbeat / claim loops responsive
  for (let i = p.range_lo; i < p.range_hi; i++) {
    const cand = indexToCandidate(p.charset, p.length, i);
    if (hashCandidate(p.algorithm, p.salt, cand) === target) {
      found = cand;
      break;
    }
    if ((i - p.range_lo) % yieldEvery === 0 && i !== p.range_lo) {
      // surrender the event loop so heartbeat/claim timers can fire
      await new Promise((r) => setImmediate(r));
    }
  }
  const runtime_ms = Date.now() - t0;
  const result = {
    status: found ? "hit" : "miss",
    candidate: found,
    scanned: total,
    range_lo: p.range_lo,
    range_hi: p.range_hi,
    length: p.length,
  };
  const result_hash = crypto
    .createHash("sha256")
    .update(JSON.stringify(result, Object.keys(result).sort()))
    .digest("hex");
  await api(
    "POST",
    "/v1/agent/work/submit",
    { workunit_id: u.workunit_id, runtime_ms, result, result_hash },
    true
  );
  stats.completed++;
  if (found) stats.hits++;
  stats.scanned += total;
  stats.ms += runtime_ms;
  send("work_done", {
    workunit_id: u.workunit_id,
    found,
    runtime_ms,
    scanned: total,
    completed: stats.completed,
    hits: stats.hits,
  });
}

async function tickClaim() {
  if (stopping) return;
  let units;
  try {
    units = await api("POST", "/v1/agent/work/claim?max_units=1", {}, true);
  } catch (e) {
    send("warn", { msg: `claim: ${e.message}` });
    return;
  }
  if (!units || !units.length) return;
  for (const u of units) {
    if (!HASH_KINDS.has(String(u.payload?.kind))) {
      // unsupported kind — return it
      await api(
        "POST",
        "/v1/agent/work/submit",
        {
          workunit_id: u.workunit_id,
          runtime_ms: 0,
          result: { skipped: true },
          result_hash: "0".repeat(64),
          error_code: "unsupported_kind",
          error_message: `kind=${u.payload?.kind}`,
        },
        true
      );
      continue;
    }
    inflight++;
    stats.claims++;
    send("work_claimed", { workunit_id: u.workunit_id, payload_kind: u.payload?.kind });
    processUnit(u)
      .catch((e) => {
        stats.failed++;
        send("work_failed", { workunit_id: u.workunit_id, msg: e.message });
      })
      .finally(() => {
        inflight = Math.max(0, inflight - 1);
      });
  }
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
parentPort.on("message", (msg) => {
  if (msg?.type === "stop") {
    stopping = true;
  }
});

(async () => {
  try {
    const dev = await pair();
    stats.paired_at = Date.now();
    send("paired", {
      device_id: dev.id,
      device_handle: dev.handle,
      device_class: dev.device_class,
      h100_equivalent: dev.h100_equivalent,
      status: dev.status,
    });

    // First heartbeat right away so the bundler can pick us up
    await heartbeat().catch((e) => send("warn", { msg: `hb0: ${e.message}` }));

    const hbTimer = setInterval(
      () => heartbeat().catch((e) => send("warn", { msg: `hb: ${e.message}` })),
      heartbeatMs
    );
    const claimTimer = setInterval(
      () => tickClaim().catch((e) => send("warn", { msg: `tick: ${e.message}` })),
      claimMs
    );

    // first tick fast
    setTimeout(() => tickClaim().catch(() => {}), 1500);

    // Run forever until stop signal
    const stopWatch = setInterval(() => {
      if (stopping) {
        clearInterval(hbTimer);
        clearInterval(claimTimer);
        clearInterval(stopWatch);
        send("stopped", { stats });
        process.exit(0);
      }
    }, 500);
  } catch (e) {
    send("error", { msg: e.message });
    process.exit(1);
  }
})();
