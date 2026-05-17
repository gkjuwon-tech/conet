import { EventEmitter } from "node:events";
import crypto from "node:crypto";
import { ApiClient, HttpError } from "./api-client";
import { store } from "./store";
import {
  HEARTBEAT_INTERVAL_MS,
  WORK_POLL_INTERVAL_MS
} from "./constants";
import { readLiveTelemetry } from "./system-info";
import { WorkerPool, type WorkerEvent } from "./worker-pool";
import {
  AdaptiveThrottle,
  decideWork,
  EconomicLedger,
  readForegroundCpuPct,
  type DeviceClass,
  type WorkDecision
} from "./economics";

export interface AgentStatus {
  running: boolean;
  deviceId: string | null;
  attested: boolean;
  inflight: number;
  capacity: number;
  lastHeartbeatAt: string | null;
  lastClaimAt: string | null;
  lastError: string | null;
  units: Array<{
    workunit_id: string;
    progress_pct: number;
    scanned?: number;
    started_at: string;
  }>;
  economics: {
    profitable: boolean;
    earning_cents_per_hour: number;
    cost_cents_per_hour: number;
    margin_cents_per_hour: number;
    target_cpu_pct: number;
    workers_allowed: number;
    explanations: string[];
    last_decision_at: string | null;
    ledger_24h: { earnings_cents: number; cost_cents: number; margin_cents: number };
  };
}

export class ConsumerAgent extends EventEmitter {
  private api: ApiClient;
  private pool: WorkerPool;
  private deviceId: string | null = null;
  private deviceToken: string | null = null;
  private hbTimer: NodeJS.Timeout | null = null;
  private claimTimer: NodeJS.Timeout | null = null;
  private attested = false;
  private lastHeartbeatAt: string | null = null;
  private lastClaimAt: string | null = null;
  private lastError: string | null = null;
  private inflightProgress = new Map<
    string,
    { workunit_id: string; progress_pct: number; scanned?: number; started_at: string }
  >();
  private running = false;
  private throttle: AdaptiveThrottle;
  private ledger = new EconomicLedger();
  private lastDecision: WorkDecision | null = null;
  private lastDecisionAt: string | null = null;
  private deviceClass: DeviceClass = "desktop";
  private deviceCountry: string | null = null;
  private deviceRateUsd: number = 0; // earning rate from cluster
  private inflightWorkStartedAt: number | null = null;

  constructor(api: ApiClient, pool: WorkerPool) {
    super();
    this.api = api;
    this.pool = pool;
    this.pool.on((event) => this.onWorkerEvent(event));
    const prefs = store.state.preferences ?? {};
    this.throttle = new AdaptiveThrottle({
      cpu_cap_pct: typeof prefs.maxCpuPct === "number" ? prefs.maxCpuPct : 10,
      worker_count: Math.max(1, this.pool.capacity || 2),
      require_charging: !!prefs.nightOnly === false ? false : true
    });
  }

  status(): AgentStatus {
    const totals = this.ledger.totals();
    const last = this.lastDecision;
    return {
      running: this.running,
      deviceId: this.deviceId,
      attested: this.attested,
      inflight: this.pool.inflight,
      capacity: this.pool.capacity,
      lastHeartbeatAt: this.lastHeartbeatAt,
      lastClaimAt: this.lastClaimAt,
      lastError: this.lastError,
      units: [...this.inflightProgress.values()],
      economics: {
        profitable: last?.profitability.profitable ?? true,
        earning_cents_per_hour: last?.profitability.earning_cents_per_hour ?? 0,
        cost_cents_per_hour: last?.profitability.cost_cents_per_hour ?? 0,
        margin_cents_per_hour: last?.profitability.margin_cents_per_hour ?? 0,
        target_cpu_pct: last?.target_cpu_pct ?? 0,
        workers_allowed: last?.workers_allowed ?? this.pool.capacity,
        explanations: last?.explanations ?? [],
        last_decision_at: this.lastDecisionAt,
        ledger_24h: totals
      }
    };
  }

  async start(deviceId: string): Promise<void> {
    if (this.running && this.deviceId === deviceId) return;
    await this.stop();

    const tokenInStore = store.state.deviceTokens?.[deviceId];
    if (tokenInStore) {
      this.deviceToken = tokenInStore;
    } else {
      const issued = await this.api.issueDeviceToken(deviceId);
      this.deviceToken = issued.token;
      await store.setDeviceToken(deviceId, issued.token);
    }

    // Refresh device economics so the throttle has up-to-date class + earning.
    try {
      const dev = (await this.api.call<{
        device_class: string;
        country_code?: string | null;
      }>({ path: `/v1/devices/${deviceId}` })) as {
        device_class: string;
      };
      this.deviceClass = (dev.device_class as DeviceClass) ?? "desktop";
      this.deviceCountry = (
        (await this.api.me()) as { country_code?: string | null }
      ).country_code ?? null;
      // Earning rate: ask for the cluster the device sits in; fall back to 0
      // (will simply be evaluated as unprofitable).
      this.deviceRateUsd = await this.estimateEarningRate(deviceId);
    } catch (err) {
      console.warn("[agent] failed to refresh economics inputs", err);
    }

    this.deviceId = deviceId;
    this.attested = false;
    this.lastError = null;
    this.running = true;

    try {
      await this.attest();
    } catch (err) {
      this.lastError = formatError(err);
      this.emit("status", this.status());
    }

    await this.heartbeatOnce().catch((err) => {
      this.lastError = formatError(err);
    });
    await this.tryClaim().catch((err) => {
      this.lastError = formatError(err);
    });

    this.hbTimer = setInterval(() => {
      void this.heartbeatOnce().catch((err) => {
        this.lastError = formatError(err);
        this.emit("status", this.status());
      });
    }, HEARTBEAT_INTERVAL_MS);

    this.claimTimer = setInterval(() => {
      void this.tryClaim().catch((err) => {
        this.lastError = formatError(err);
        this.emit("status", this.status());
      });
    }, WORK_POLL_INTERVAL_MS);

    this.emit("status", this.status());
  }

  async stop(): Promise<void> {
    if (this.hbTimer) {
      clearInterval(this.hbTimer);
      this.hbTimer = null;
    }
    if (this.claimTimer) {
      clearInterval(this.claimTimer);
      this.claimTimer = null;
    }
    this.pool.cancelAll();
    this.running = false;
    this.deviceId = null;
    this.deviceToken = null;
    this.attested = false;
    this.inflightProgress.clear();
    this.emit("status", this.status());
  }

  private async attest(): Promise<void> {
    if (!this.deviceToken) return;
    const challenge = await this.api.attestChallenge(this.deviceToken);
    if (challenge.method === "pow") {
      const candidate = await mineProofOfWork(challenge.nonce, challenge.difficulty);
      const verify = await this.api.attestVerify(this.deviceToken, {
        nonce: challenge.nonce,
        candidate,
        difficulty: challenge.difficulty
      });
      this.attested = !!verify.ok;
    } else {
      this.attested = false;
    }
  }

  private async heartbeatOnce(): Promise<void> {
    if (!this.deviceToken) return;
    const live = await readLiveTelemetry();
    await this.api.deviceHeartbeat(this.deviceToken, {
      cpu_usage_pct: live.cpu_usage_pct,
      gpu_usage_pct: live.gpu_usage_pct,
      ram_usage_pct: live.ram_usage_pct,
      temperature_c: live.temperature_c,
      download_mbps: live.download_mbps,
      upload_mbps: live.upload_mbps,
      extras: { agent: "electromesh-consumer", inflight: this.pool.inflight }
    });
    this.lastHeartbeatAt = new Date().toISOString();
    this.emit("status", this.status());
  }

  private async tryClaim(): Promise<void> {
    if (!this.deviceToken || !this.attested) return;
    if (this.pool.capacity <= 0) return;

    // PROFITABILITY GATE — never claim work that loses the user money.
    const decision = await this.computeWorkDecision();
    this.lastDecision = decision;
    this.lastDecisionAt = new Date().toISOString();
    if (!decision.should_run) {
      // Surface why we're skipping; cancel any in-flight units that became
      // unprofitable (e.g. user unplugged a laptop mid-job).
      this.lastError = `paused: ${decision.explanations.join("; ") || "unprofitable"}`;
      if (decision.throttle.pause && this.pool.inflight > 0) {
        this.pool.cancelAll();
      }
      this.emit("status", this.status());
      return;
    }

    // Cap concurrent workers via throttle decision.
    const wantUnits = Math.max(
      0,
      Math.min(decision.workers_allowed, this.pool.capacity, 2)
    );
    if (wantUnits === 0) {
      this.emit("status", this.status());
      return;
    }
    const units = await this.api.claimWork(this.deviceToken, wantUnits);
    this.lastClaimAt = new Date().toISOString();
    if (units.length === 0) {
      this.emit("status", this.status());
      return;
    }
    for (const u of units) {
      const job = {
        workunit_id: u.workunit_id,
        payload: u.payload,
        expected_runtime_seconds: u.expected_runtime_seconds
      };
      if (!this.pool.canRun(job)) {
        await this.api
          .submitWork(this.deviceToken, {
            workunit_id: u.workunit_id,
            runtime_ms: 0,
            result: { skipped: true },
            result_hash: "0".repeat(64),
            error_code: "unsupported_kind",
            error_message: `kind=${String(u.payload.kind)}`
          })
          .catch(() => undefined);
        continue;
      }
      this.inflightProgress.set(u.workunit_id, {
        workunit_id: u.workunit_id,
        progress_pct: 0,
        started_at: new Date().toISOString()
      });
      const started = this.pool.start(job);
      if (!started) {
        this.inflightProgress.delete(u.workunit_id);
      }
    }
    this.emit("status", this.status());
  }

  private async onWorkerEvent(event: WorkerEvent): Promise<void> {
    if (!this.deviceToken) return;
    if (event.type === "progress") {
      const cur = this.inflightProgress.get(event.workunit_id);
      if (cur) {
        cur.progress_pct = event.progress_pct;
        cur.scanned = event.scanned;
      }
      this.emit("status", this.status());
      return;
    }
    if (event.type === "result") {
      try {
        await this.api.submitWork(this.deviceToken, {
          workunit_id: event.workunit_id,
          runtime_ms: event.runtime_ms,
          result: event.result,
          result_hash: event.result_hash
        });
      } catch (err) {
        this.lastError = formatError(err);
      }
      this.inflightProgress.delete(event.workunit_id);
      this.emit("status", this.status());
      return;
    }
    if (event.type === "error") {
      try {
        await this.api.submitWork(this.deviceToken, {
          workunit_id: event.workunit_id,
          runtime_ms: event.runtime_ms,
          result: { error: true },
          result_hash: "0".repeat(64),
          error_code: event.error_code,
          error_message: event.error_message
        });
      } catch (err) {
        this.lastError = formatError(err);
      }
      this.inflightProgress.delete(event.workunit_id);
      this.emit("status", this.status());
    }
  }

  // ---- Economics helpers ----

  private async estimateEarningRate(deviceId: string): Promise<number> {
    try {
      const cluster = (await this.api.call<{ price_usd_per_hour?: number; member_count?: number } | null>({
        path: `/v1/devices/${deviceId}/cluster`
      })) as { price_usd_per_hour?: number; member_count?: number } | null;
      if (cluster && typeof cluster.price_usd_per_hour === "number") {
        const share = cluster.member_count ? 1 / cluster.member_count : 1;
        // Approx: pool ≈ 0.85 of price after platform fee.
        return cluster.price_usd_per_hour * 0.85 * share;
      }
    } catch {
      /* fall through */
    }
    // Fallback heuristic: enough to cover idle electricity for a desktop class.
    return 0.05 * 0.85;
  }

  private async computeWorkDecision(): Promise<WorkDecision> {
    const live = await readLiveTelemetry();
    const fg = await readForegroundCpuPct();
    const battery = (globalThis as { __em_battery?: { on_battery: boolean; pct: number | null } })
      .__em_battery ?? { on_battery: false, pct: null };
    const prefs = store.state.preferences ?? {};
    const cap = typeof prefs.maxCpuPct === "number" ? prefs.maxCpuPct : 10;
    const earningCentsHour = this.deviceRateUsd * 100;
    return decideWork({
      deviceClass: this.deviceClass,
      expectedEarningCentsPerHour: earningCentsHour,
      cpuUsagePct: live.cpu_usage_pct,
      foregroundCpuPct: fg,
      temperatureC: live.temperature_c,
      onBattery: battery.on_battery,
      batteryPct: battery.pct,
      targetMaxCpuPct: cap,
      countryCode: this.deviceCountry,
      throttle: this.throttle
    });
  }

  recordEarningCents(cents: number, runtime_ms: number): void {
    const hours = Math.max(0.0001, runtime_ms / 1000 / 3600);
    const cost =
      this.lastDecision?.cost.cost_cents_per_hour !== undefined
        ? this.lastDecision.cost.cost_cents_per_hour * hours
        : 0;
    this.ledger.record(cents, cost);
  }
}

async function mineProofOfWork(nonce: string, difficulty: number): Promise<string> {
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
      const v = digest[fullBytes] ?? 0;
      ok = (v >> (8 - bitRem)) === 0;
    }
    if (ok) return cand;
    if (i % 50_000 === 0) await new Promise((r) => setImmediate(r));
  }
}

function formatError(err: unknown): string {
  if (err instanceof HttpError) return `${err.code}: ${err.message}`;
  if (err instanceof Error) return err.message;
  return String(err);
}
