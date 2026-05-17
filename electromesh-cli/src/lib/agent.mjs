import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import os from "node:os";
import pc from "picocolors";
import { api } from "./api.mjs";
import { readLiveTelemetry } from "./system.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HASH_KINDS = new Set(["hashcrack.range", "hashcrack.dict"]);
const WORKER_PATH = path.join(__dirname, "hash-worker.mjs");

const HEARTBEAT_MS = 8_000;
const CLAIM_MS = 3_000;

export class Agent {
  constructor({ deviceId, deviceToken, onLog = () => {} }) {
    this.deviceId = deviceId;
    this.deviceToken = deviceToken;
    this.maxConcurrent = Math.max(1, Math.floor(os.cpus().length / 2));
    this.active = new Map();
    this.attested = false;
    this.running = false;
    this.onLog = onLog;
    this._timers = [];
    this.stats = { completed: 0, failed: 0, totalRuntimeMs: 0 };
  }

  async start() {
    if (this.running) return;
    this.running = true;
    this.onLog(pc.cyan("• attesting…"));
    await this.attest();
    this.onLog(pc.green("✓ attested"));

    await this.heartbeat().catch((e) =>
      this.onLog(pc.yellow(`! heartbeat: ${e.message}`))
    );

    this._timers.push(
      setInterval(
        () => this.heartbeat().catch((e) => this.onLog(pc.yellow(`! hb: ${e.message}`))),
        HEARTBEAT_MS
      )
    );
    this._timers.push(
      setInterval(
        () => this.tick().catch((e) => this.onLog(pc.yellow(`! tick: ${e.message}`))),
        CLAIM_MS
      )
    );
    void this.tick();
  }

  stop() {
    this.running = false;
    for (const t of this._timers) clearInterval(t);
    this._timers = [];
    for (const w of this.active.values()) w.terminate().catch(() => undefined);
    this.active.clear();
  }

  async attest() {
    const challenge = await api.attestChallenge(this.deviceToken);
    if (challenge.method !== "pow") {
      throw new Error(`unsupported attest method: ${challenge.method}`);
    }
    this.onLog(pc.dim(`  pow nonce=${challenge.nonce.slice(0, 16)}… difficulty=${challenge.difficulty}`));
    const candidate = await mineProofOfWork(challenge.nonce, challenge.difficulty);
    const result = await api.attestVerify(this.deviceToken, {
      nonce: challenge.nonce,
      candidate,
      difficulty: challenge.difficulty
    });
    this.attested = !!result.ok;
    if (!this.attested) throw new Error("attestation failed");
  }

  async heartbeat() {
    const live = await readLiveTelemetry();
    await api.heartbeat(this.deviceToken, {
      cpu_usage_pct: live.cpu_usage_pct,
      gpu_usage_pct: live.gpu_usage_pct,
      ram_usage_pct: live.ram_usage_pct,
      temperature_c: live.temperature_c,
      download_mbps: live.download_mbps,
      upload_mbps: live.upload_mbps,
      extras: { agent: "electromesh-cli", inflight: this.active.size }
    });
  }

  async tick() {
    if (!this.attested || !this.running) return;
    const capacity = this.maxConcurrent - this.active.size;
    if (capacity <= 0) return;
    const units = await api.claimWork(this.deviceToken, Math.min(capacity, 2));
    for (const u of units) {
      if (!HASH_KINDS.has(String(u.payload?.kind))) {
        this.onLog(pc.yellow(`  skip ${u.workunit_id} (kind=${u.payload?.kind})`));
        await api.submitWork(this.deviceToken, {
          workunit_id: u.workunit_id,
          runtime_ms: 0,
          result: { skipped: true },
          result_hash: "0".repeat(64),
          error_code: "unsupported_kind",
          error_message: `kind=${u.payload?.kind}`
        });
        continue;
      }
      this.spawn(u);
    }
  }

  spawn(unit) {
    if (this.active.has(unit.workunit_id)) return;
    this.onLog(
      pc.cyan(
        `▸ ${unit.workunit_id} ${pc.dim(`len=${unit.payload.length}, range=${unit.payload.range_lo}..${unit.payload.range_hi}`)}`
      )
    );
    const worker = new Worker(WORKER_PATH, {
      workerData: { workunit_id: unit.workunit_id, payload: unit.payload }
    });
    this.active.set(unit.workunit_id, worker);

    worker.on("message", async (msg) => {
      if (msg.type === "progress") {
        if (process.env.EM_VERBOSE)
          this.onLog(
            pc.dim(`  ${msg.workunit_id} ${msg.progress_pct.toFixed(0)}% scanned=${msg.scanned}`)
          );
        return;
      }
      if (msg.type === "result") {
        const result_hash = sha256Json(msg.result);
        try {
          const r = await api.submitWork(this.deviceToken, {
            workunit_id: msg.workunit_id,
            runtime_ms: msg.runtime_ms,
            result: msg.result,
            result_hash
          });
          this.stats.completed++;
          this.stats.totalRuntimeMs += msg.runtime_ms;
          const status = msg.result.status === "hit" ? pc.green("HIT") : pc.dim("miss");
          const candidate = msg.result.candidate ? pc.bold(pc.green(`  → ${msg.result.candidate}`)) : "";
          const consensus = r.consensus_achieved ? pc.green(" consensus✓") : pc.yellow(" pending");
          this.onLog(
            `${pc.green("✓")} ${msg.workunit_id} ${status} ${pc.dim(`${msg.runtime_ms}ms`)}${consensus}${candidate}`
          );
        } catch (err) {
          this.onLog(pc.red(`✗ submit ${msg.workunit_id}: ${err.message}`));
          this.stats.failed++;
        } finally {
          this.active.delete(msg.workunit_id);
        }
      }
    });

    worker.on("error", async (err) => {
      this.onLog(pc.red(`✗ worker error ${unit.workunit_id}: ${err.message}`));
      this.active.delete(unit.workunit_id);
      this.stats.failed++;
      try {
        await api.submitWork(this.deviceToken, {
          workunit_id: unit.workunit_id,
          runtime_ms: 0,
          result: { error: true },
          result_hash: "0".repeat(64),
          error_code: "worker_error",
          error_message: String(err.message ?? err).slice(0, 500)
        });
      } catch {
        /* noop */
      }
    });

    worker.on("exit", (code) => {
      if (this.active.has(unit.workunit_id) && code !== 0) {
        this.onLog(pc.yellow(`  worker ${unit.workunit_id} exited with ${code}`));
        this.active.delete(unit.workunit_id);
      }
    });
  }
}

function sha256Json(obj) {
  const keys = Object.keys(obj).sort();
  return crypto.createHash("sha256").update(JSON.stringify(obj, keys)).digest("hex");
}

export async function mineProofOfWork(nonce, difficulty) {
  const fullBytes = Math.floor(difficulty / 8);
  const bitRem = difficulty % 8;
  for (let i = 0; ; i++) {
    const cand = `${i}-${crypto.randomBytes(4).toString("hex")}`;
    const digest = crypto.createHash("sha256").update(`${nonce}:${cand}`).digest();
    let ok = true;
    for (let b = 0; b < fullBytes; b++) {
      if (digest[b] !== 0) {
        ok = false;
        break;
      }
    }
    if (ok && bitRem !== 0) {
      ok = (digest[fullBytes] >> (8 - bitRem)) === 0;
    }
    if (ok) return cand;
    if (i % 50_000 === 0) await new Promise((r) => setImmediate(r));
  }
}
