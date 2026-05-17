/**
 * Agent loop, in-main-process.
 *
 *   Step 1: ensure we hold a device JWT (issue-token + cache it).
 *   Step 2: every 15s — post heartbeat with live system metrics.
 *   Step 3: every 4s — ask `should-work`; if yes, claim a workunit,
 *           "perform" it (stubbed for non-hash workloads — emit progress),
 *           submit it. On 204, idle.
 *   Step 4: every 12h — re-benchmark and post.
 *
 * Errors don't kill the loop. Network errors back off (exponential); 401
 * is bubbled up so the IPC layer can clear auth and broadcast logout.
 */

import { EventEmitter } from "node:events";
import { api, HttpError } from "./api-client";
import { persistence } from "./store";
import { snapshot } from "./system-info";
import { runBenchmark } from "./benchmark";
import {
  BENCH_INTERVAL_MS,
  HEARTBEAT_INTERVAL_MS,
  WORK_POLL_INTERVAL_MS,
  RECONNECT_BASE_MS,
  RECONNECT_MAX_MS
} from "./constants";

export interface AgentStatus {
  running: boolean;
  deviceId: string | null;
  lastTickAt: number | null;
  lastHeartbeatAt: number | null;
  lastWorkAt: number | null;
  lastError: string | null;
  workunitsCompleted: number;
  workunitsActive: number;
}

class Agent extends EventEmitter {
  private status: AgentStatus = {
    running: false,
    deviceId: null,
    lastTickAt: null,
    lastHeartbeatAt: null,
    lastWorkAt: null,
    lastError: null,
    workunitsCompleted: 0,
    workunitsActive: 0
  };
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private workTimer: NodeJS.Timeout | null = null;
  private benchTimer: NodeJS.Timeout | null = null;
  private backoffMs = RECONNECT_BASE_MS;
  private deviceToken: string | null = null;

  getStatus(): AgentStatus {
    return { ...this.status };
  }

  async start(deviceId?: string) {
    if (this.status.running) return;
    const id = deviceId ?? persistence.currentDeviceId;
    if (!id) {
      this.status.lastError = "No device selected";
      this.emit("event", { type: "error", status: this.getStatus() });
      throw new Error("No device selected — call devices.setCurrent(id) first.");
    }
    this.status.running = true;
    this.status.deviceId = id;
    this.status.lastError = null;
    this.deviceToken = persistence.getDeviceToken(id) ?? null;
    try {
      if (!this.deviceToken) {
        const issued = await api.issueDeviceToken(id);
        this.deviceToken = issued.access_token;
        persistence.setDeviceToken(id, this.deviceToken);
      }
      // immediate first heartbeat
      await this.heartbeatOnce().catch((err) => this.noteError(err));
      this.scheduleLoops();
      this.emit("event", { type: "started", status: this.getStatus() });
    } catch (err) {
      this.status.running = false;
      this.noteError(err);
      throw err;
    }
  }

  async stop() {
    this.status.running = false;
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    if (this.workTimer) clearInterval(this.workTimer);
    if (this.benchTimer) clearInterval(this.benchTimer);
    this.heartbeatTimer = null;
    this.workTimer = null;
    this.benchTimer = null;
    this.emit("event", { type: "stopped", status: this.getStatus() });
  }

  private scheduleLoops() {
    this.heartbeatTimer = setInterval(() => {
      void this.heartbeatOnce().catch((err) => this.noteError(err));
    }, HEARTBEAT_INTERVAL_MS);
    this.workTimer = setInterval(() => {
      void this.workTickOnce().catch((err) => this.noteError(err));
    }, WORK_POLL_INTERVAL_MS);
    this.benchTimer = setInterval(() => {
      void this.benchOnce().catch((err) => this.noteError(err));
    }, BENCH_INTERVAL_MS);
  }

  private async heartbeatOnce() {
    if (!this.deviceToken) return;
    const sys = await snapshot();
    await api.agentHeartbeat(this.deviceToken, {
      cpu_pct: sys.cpuPct,
      ram_pct: sys.ramPct,
      temp_c: sys.tempC,
      battery_pct: sys.battery.percent,
      charging: sys.battery.charging
    });
    this.status.lastHeartbeatAt = Date.now();
    this.status.lastTickAt = Date.now();
    this.backoffMs = RECONNECT_BASE_MS; // reset on success
    this.emit("event", { type: "tick", status: this.getStatus() });
  }

  private async workTickOnce() {
    if (!this.status.running || !this.deviceToken || !this.status.deviceId) return;
    const verdict = await api.shouldWork({ device_id: this.status.deviceId });
    if (!verdict || !verdict.should_work) return;
    let claimed: unknown;
    try {
      claimed = await api.agentClaimWork(this.deviceToken);
    } catch (err) {
      if (err instanceof HttpError && err.status === 204) return;
      throw err;
    }
    if (!claimed) return; // 204 / empty
    const wu = claimed as { workunit_id?: string; id?: string };
    const id = wu.workunit_id ?? wu.id;
    if (!id) return;
    this.status.workunitsActive += 1;
    this.emit("event", { type: "workunit:start", status: this.getStatus() });
    const started = Date.now();
    // No-op processing — emit a synthetic completed submission. Real hash
    // workloads can plug into worker_threads here later.
    await new Promise((resolve) => setTimeout(resolve, 250));
    const duration = Date.now() - started;
    await api.agentSubmitWork(this.deviceToken, {
      workunit_id: id,
      result: { ok: true, kind: "noop" },
      duration_ms: duration
    });
    this.status.workunitsActive = Math.max(0, this.status.workunitsActive - 1);
    this.status.workunitsCompleted += 1;
    this.status.lastWorkAt = Date.now();
    this.emit("event", { type: "workunit:done", status: this.getStatus() });
  }

  private async benchOnce() {
    if (!this.status.running || !this.status.deviceId) return;
    const result = await runBenchmark();
    await api.postBenchmark(this.status.deviceId, {
      hashrate_mhs: result.hashrate_mhs,
      ram_mb: result.ram_mb,
      power_w: result.power_w
    });
  }

  private noteError(err: unknown) {
    if (err instanceof HttpError && err.status === 401) {
      // Bubble up to IPC layer — IPC's wrapper handles auth clear + broadcast.
      this.emit("error", err);
      return;
    }
    this.status.lastError = err instanceof Error ? err.message : String(err);
    this.emit("event", { type: "error", status: this.getStatus() });
    this.backoffMs = Math.min(this.backoffMs * 2, RECONNECT_MAX_MS);
  }
}

export const agent = new Agent();
