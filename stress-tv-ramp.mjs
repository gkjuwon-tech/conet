// Hammer the LAN with sha256 hashcrack jobs of escalating difficulty.
// The browser-PWA agent (your TV / phone / fridge) will pull workunits
// off the queue as fast as it can; this script is purely a producer.
//
// Usage:
//   node stress-tv-ramp.mjs                # default ramp: lengths 3 → 7
//   node stress-tv-ramp.mjs --max-length 8 # go further
//   node stress-tv-ramp.mjs --once 6       # send a single length=6 burst
//
// Watch progress on the TV browser itself — the PWA shows live KH/s,
// HIT/miss, cumulative hashes. When the TV browser tab dies / freezes /
// kicks you back to the home screen, that's its limit.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";

const BACKEND = process.env.EM_BACKEND ?? "http://localhost:8080";
const STATE = JSON.parse(fs.readFileSync(path.join(os.homedir(), ".electromesh", "state.json"), "utf8"));
const ENT_KEY = STATE.enterprise?.apiKey;
if (!ENT_KEY) {
  console.error("✗ no enterprise key in CLI state — run `em enterprise create` first");
  process.exit(1);
}
const USER_TOK = STATE.userToken;

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, cur, i, arr) => {
    if (cur.startsWith("--")) acc.push([cur.slice(2), arr[i + 1]]);
    return acc;
  }, [])
);
const ONCE = args.once ? Number(args.once) : null;
const MAX_LEN = args["max-length"] ? Number(args["max-length"]) : 7;

const CHARSET = "abcdefghijklmnopqrstuvwxyz";

async function submitJob(length, secret) {
  const target = crypto.createHash("sha256").update(secret).digest("hex");
  const total = Math.pow(CHARSET.length, length);
  const chunkSize = Math.max(10000, Math.floor(total / 200));
  const body = {
    kind: "hashcrack.range",
    title: `stress-ramp len=${length} → "${secret}"`,
    target_cluster_count: 1,
    target_h100_equivalent: 0.0001,
    max_budget_cents: 5000,
    max_runtime_seconds: 1200,
    hashcrack_range: {
      algorithm: "sha256",
      target_hash: target,
      charset: CHARSET,
      min_length: length,
      max_length: length,
      range_lo: 0,
      range_hi: total,
      chunk_size: chunkSize,
    },
  };
  const res = await fetch(`${BACKEND}/v1/jobs`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Api-Key": ENT_KEY },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`HTTP ${res.status}: ${t.slice(0, 200)}`);
  }
  const job = await res.json();
  return { job, total, chunkSize, target };
}

async function pollJob(jobId, deadlineMs) {
  while (Date.now() < deadlineMs) {
    const res = await fetch(`${BACKEND}/v1/jobs/${jobId}`, {
      headers: { "X-Api-Key": ENT_KEY },
    });
    if (res.ok) {
      const j = await res.json();
      const total = j.workunit_total ?? 0;
      const done = j.workunits_completed ?? 0;
      process.stdout.write(
        `\r    ${j.status.padEnd(10)} workunits ${done}/${total}  attempts ${j.workunit_attempts ?? "?"}  spent ${(j.spent_cents ?? 0) / 100}¢   `
      );
      if (["succeeded", "failed", "cancelled"].includes(j.status)) {
        process.stdout.write("\n");
        return j;
      }
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  process.stdout.write("\n");
  return null;
}

function pickSecret(length) {
  // Pick a recognizable lower-alpha string of the EXACT requested length.
  // Lands in the search space at a deterministic offset so a real HIT pops
  // on the TV.
  const samples = {
    3: "tvt",
    4: "yolo",
    5: "yoyoo",
    6: "tvtvtv",
    7: "yoloyol",
    8: "konetkon",
  };
  return samples[length] ?? "y".repeat(length);
}

async function main() {
  console.log(`⚡ conet · stress ramp  ·  backend=${BACKEND}`);
  const lens = ONCE ? [ONCE] : [];
  if (!ONCE) for (let l = 3; l <= MAX_LEN; l++) lens.push(l);

  for (const length of lens) {
    const secret = pickSecret(length);
    console.log(
      `\n▶ length=${length}  secret="${secret}"  search-space=${Math.pow(CHARSET.length, length).toLocaleString()}`
    );
    const t0 = Date.now();
    const { job, chunkSize } = await submitJob(length, secret);
    console.log(
      `  job ${job.handle.slice(0, 22)}…  workunits=${job.workunit_total}  chunk=${chunkSize.toLocaleString()}`
    );
    const final = await pollJob(job.id, Date.now() + 1000 * 60 * 10);
    const dt = ((Date.now() - t0) / 1000).toFixed(1);
    if (!final) {
      console.log(`  ⏱  timeout after ${dt}s — moving on (TV may have melted)`);
      continue;
    }
    console.log(
      `  ✓ ${final.status} in ${dt}s  ·  spent ${(final.spent_cents ?? 0) / 100}¢`
    );
  }
  console.log("\n🏁  ramp finished.");
}

main().catch((e) => {
  console.error("✗", e.message);
  process.exit(1);
});
