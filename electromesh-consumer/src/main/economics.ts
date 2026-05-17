/**
 * Client-side mirror of `app/services/economics.py`.
 *
 * The agent runs the same profitability check locally before claiming work,
 * so we never *start* a job that would lose the user money on electricity.
 * The backend gets the final say but if we already know it's a loser we
 * skip the round-trip.
 *
 * Two write paths use this:
 *   - The claim loop (every 4s): pre-flight check.
 *   - The renderer (Dashboard / Settings): live "you're earning $X / hour
 *     and burning $Y of electricity" widget.
 */

import os from "node:os";

export type DeviceClass =
  | "smart_bulb"
  | "smart_plug"
  | "smart_tv"
  | "fridge"
  | "washer"
  | "dryer"
  | "microwave"
  | "router"
  | "nas"
  | "desktop"
  | "laptop"
  | "console"
  | "phone"
  | "tablet"
  | "gpu_rig"
  | "other_iot";

interface PowerProfile {
  idle_w: number;
  load_w: number;
  base_w: number;
  has_battery: boolean;
  typical_capacity_wh: number;
}

const POWER_PROFILES: Record<DeviceClass, PowerProfile> = {
  smart_bulb: { idle_w: 0.4, load_w: 1.0, base_w: 0.4, has_battery: false, typical_capacity_wh: 0 },
  smart_plug: { idle_w: 0.5, load_w: 1.2, base_w: 0.5, has_battery: false, typical_capacity_wh: 0 },
  smart_tv: { idle_w: 12, load_w: 22, base_w: 10, has_battery: false, typical_capacity_wh: 0 },
  fridge: { idle_w: 2, load_w: 4.5, base_w: 80, has_battery: false, typical_capacity_wh: 0 },
  washer: { idle_w: 1.5, load_w: 3, base_w: 1, has_battery: false, typical_capacity_wh: 0 },
  dryer: { idle_w: 1.5, load_w: 3, base_w: 1, has_battery: false, typical_capacity_wh: 0 },
  microwave: { idle_w: 2, load_w: 4, base_w: 2, has_battery: false, typical_capacity_wh: 0 },
  router: { idle_w: 6, load_w: 10, base_w: 6, has_battery: false, typical_capacity_wh: 0 },
  nas: { idle_w: 18, load_w: 42, base_w: 15, has_battery: false, typical_capacity_wh: 0 },
  desktop: { idle_w: 70, load_w: 240, base_w: 55, has_battery: false, typical_capacity_wh: 0 },
  laptop: { idle_w: 10, load_w: 55, base_w: 8, has_battery: true, typical_capacity_wh: 60 },
  console: { idle_w: 30, load_w: 180, base_w: 20, has_battery: false, typical_capacity_wh: 0 },
  phone: { idle_w: 0.6, load_w: 4.5, base_w: 0.5, has_battery: true, typical_capacity_wh: 15 },
  tablet: { idle_w: 1, load_w: 8, base_w: 0.8, has_battery: true, typical_capacity_wh: 30 },
  gpu_rig: { idle_w: 120, load_w: 520, base_w: 80, has_battery: false, typical_capacity_wh: 0 },
  other_iot: { idle_w: 2, load_w: 4, base_w: 2, has_battery: false, typical_capacity_wh: 0 }
};

interface Tariff {
  region: string;
  default_rate_usd_kwh: number;
  peak_multiplier: number;
  peak_window: [number, number];
  notes: string;
}

const TARIFFS: Record<string, Tariff> = {
  KR: { region: "KR", default_rate_usd_kwh: 0.13, peak_multiplier: 1, peak_window: [0, 0], notes: "KEPCO" },
  US: { region: "US", default_rate_usd_kwh: 0.16, peak_multiplier: 1.2, peak_window: [20, 26], notes: "EIA avg" },
  DE: { region: "DE", default_rate_usd_kwh: 0.36, peak_multiplier: 1, peak_window: [0, 0], notes: "" },
  JP: { region: "JP", default_rate_usd_kwh: 0.27, peak_multiplier: 1, peak_window: [0, 0], notes: "" },
  CN: { region: "CN", default_rate_usd_kwh: 0.08, peak_multiplier: 1, peak_window: [0, 0], notes: "" },
  IN: { region: "IN", default_rate_usd_kwh: 0.07, peak_multiplier: 1, peak_window: [0, 0], notes: "" },
  BR: { region: "BR", default_rate_usd_kwh: 0.18, peak_multiplier: 1, peak_window: [0, 0], notes: "" },
  DEFAULT: { region: "DEFAULT", default_rate_usd_kwh: 0.2, peak_multiplier: 1, peak_window: [0, 0], notes: "" }
};

export function lookupTariff(country?: string | null): Tariff {
  if (!country) return TARIFFS.DEFAULT;
  return TARIFFS[country.toUpperCase()] ?? TARIFFS.DEFAULT;
}

export interface CostEstimate {
  idle_w: number;
  load_w: number;
  attributable_w: number;
  rate_usd_kwh: number;
  cost_cents_per_hour: number;
  explanation: string;
}

export function estimateCost(opts: {
  deviceClass: DeviceClass;
  utilisationPct: number;
  countryCode?: string | null;
  userOverrideRateUsdKwh?: number | null;
  measuredIdleW?: number | null;
  measuredLoadW?: number | null;
}): CostEstimate {
  const profile = POWER_PROFILES[opts.deviceClass] ?? POWER_PROFILES.other_iot;
  const idle = opts.measuredIdleW ?? profile.idle_w;
  let load = opts.measuredLoadW ?? profile.load_w;
  if (load < idle) load = idle;
  const util = Math.max(0, Math.min(100, opts.utilisationPct)) / 100;
  const attributable_w = (load - idle) * util;
  const tariff = lookupTariff(opts.countryCode);
  let rate = Math.max(tariff.default_rate_usd_kwh, opts.userOverrideRateUsdKwh ?? 0);
  if (tariff.peak_multiplier > 1 && tariff.peak_window[0] !== tariff.peak_window[1]) {
    const h = new Date().getUTCHours() + new Date().getUTCMinutes() / 60;
    const [lo, hi] = tariff.peak_window;
    const inWindow = lo <= hi ? h >= lo && h < hi : h >= lo || h < hi % 24;
    if (inWindow) rate *= tariff.peak_multiplier;
  }
  const cost_usd_hour = (attributable_w / 1000) * rate;
  return {
    idle_w: idle,
    load_w: load,
    attributable_w,
    rate_usd_kwh: rate,
    cost_cents_per_hour: cost_usd_hour * 100,
    explanation: `(${load.toFixed(1)}W - ${idle.toFixed(1)}W) × ${(util * 100).toFixed(0)}% × $${rate.toFixed(4)}/kWh = $${cost_usd_hour.toFixed(6)}/hr`
  };
}

export interface ProfitabilityVerdict {
  profitable: boolean;
  earning_cents_per_hour: number;
  cost_cents_per_hour: number;
  margin_cents_per_hour: number;
  margin_pct: number;
  safety_buffer_cents_per_hour: number;
  reasons: string[];
  recommended_action: "run" | "throttle" | "pause";
}

export function evaluateProfitability(opts: {
  earningCentsPerHour: number;
  cost: CostEstimate;
  safetyMarginPct?: number;
}): ProfitabilityVerdict {
  const earning = Math.max(0, opts.earningCentsPerHour);
  const expense = Math.max(0, opts.cost.cost_cents_per_hour);
  const safety = expense * (opts.safetyMarginPct ?? 0.3);
  const margin = earning - expense - safety;
  const reasons: string[] = [];
  if (expense <= 0) reasons.push("no_power_model_available");
  if (earning <= expense) reasons.push("earnings_below_electricity_cost");
  else if (earning <= expense + safety) reasons.push("earnings_below_safety_margin");
  const profitable =
    reasons.length === 0 ||
    (reasons.length === 1 && reasons[0] === "no_power_model_available" && earning > 0);
  const action: ProfitabilityVerdict["recommended_action"] = profitable
    ? "run"
    : margin > -expense * 0.5
      ? "throttle"
      : "pause";
  return {
    profitable,
    earning_cents_per_hour: earning,
    cost_cents_per_hour: expense,
    margin_cents_per_hour: margin,
    margin_pct: (margin / Math.max(earning, 1e-9)) * 100,
    safety_buffer_cents_per_hour: safety,
    reasons,
    recommended_action: action
  };
}

// ---------------------------------------------------------------------------
// Adaptive throttle (mirrors AdaptiveThrottle in the backend)
// ---------------------------------------------------------------------------

export interface ThrottleSnapshot {
  cpu_usage_pct: number;
  foreground_cpu_pct: number;
  temperature_c: number | null;
  on_battery: boolean;
  battery_pct: number | null;
  profitable: boolean;
  margin_cents_per_hour: number;
  target_max_cpu_pct: number;
}

export interface ThrottleDecision {
  target_cpu_pct: number;
  workers_allowed: number;
  pause: boolean;
  reasons: string[];
  derate_reason: string | null;
}

export interface ThrottleConfig {
  cpu_cap_pct: number;
  worker_count: number;
  thermal_warn_c: number;
  thermal_cutoff_c: number;
  battery_floor_pct: number;
  require_charging: boolean;
  max_delta_pct_per_tick: number;
}

export class AdaptiveThrottle {
  private cfg: ThrottleConfig;
  private current: number;

  constructor(cfg: Partial<ThrottleConfig> & { cpu_cap_pct: number; worker_count: number }) {
    this.cfg = {
      thermal_warn_c: 78,
      thermal_cutoff_c: 88,
      battery_floor_pct: 40,
      require_charging: true,
      max_delta_pct_per_tick: 4,
      ...cfg
    };
    this.current = cfg.cpu_cap_pct;
  }

  observe(snap: ThrottleSnapshot): ThrottleDecision {
    const reasons: string[] = [];
    let target = this.current;
    let derate: string | null = null;
    let pause = false;

    if (snap.on_battery && this.cfg.require_charging) {
      reasons.push("on_battery_no_charging_required");
      target = 0;
      pause = true;
    } else if (
      snap.on_battery &&
      snap.battery_pct !== null &&
      snap.battery_pct < this.cfg.battery_floor_pct
    ) {
      reasons.push(`battery_below_floor_${this.cfg.battery_floor_pct}`);
      target = 0;
      pause = true;
    } else if (
      snap.temperature_c !== null &&
      snap.temperature_c >= this.cfg.thermal_cutoff_c
    ) {
      reasons.push(`thermal_cutoff_${this.cfg.thermal_cutoff_c}c`);
      target = 0;
      pause = true;
      derate = "thermal_cutoff";
    } else if (!snap.profitable) {
      reasons.push("unprofitable");
      target = Math.max(target * 0.25, 0);
      derate = "unprofitable_soft_pause";
    } else {
      const free = Math.max(0, 100 - snap.foreground_cpu_pct);
      let ideal = Math.min(snap.target_max_cpu_pct, free * 0.9);
      ideal = Math.max(0, ideal);
      if (
        snap.temperature_c !== null &&
        snap.temperature_c >= this.cfg.thermal_warn_c
      ) {
        reasons.push(`thermal_warn_${snap.temperature_c.toFixed(0)}c_soft_derate`);
        const factor =
          1 -
          Math.min(
            0.6,
            (snap.temperature_c - this.cfg.thermal_warn_c) /
              (this.cfg.thermal_cutoff_c - this.cfg.thermal_warn_c)
          );
        ideal *= factor;
        derate = "thermal_warn";
      }
      if (snap.margin_cents_per_hour > 0.05) {
        ideal = Math.min(ideal + 1, snap.target_max_cpu_pct);
      }
      target = this.clampDelta(ideal);
    }

    target = Math.max(0, Math.min(target, snap.target_max_cpu_pct));
    this.current = target;

    const perWorker = Math.max(1, 100 / Math.max(this.cfg.worker_count, 1));
    let workers = Math.floor(target / perWorker);
    workers = Math.max(0, Math.min(workers, this.cfg.worker_count));

    return { target_cpu_pct: target, workers_allowed: workers, pause, reasons, derate_reason: derate };
  }

  private clampDelta(ideal: number): number {
    const delta = ideal - this.current;
    if (Math.abs(delta) <= this.cfg.max_delta_pct_per_tick) return ideal;
    return this.current + Math.sign(delta) * this.cfg.max_delta_pct_per_tick;
  }
}

// ---------------------------------------------------------------------------
// Decision aggregator + telemetry helpers
// ---------------------------------------------------------------------------

export interface WorkDecision {
  should_run: boolean;
  target_cpu_pct: number;
  workers_allowed: number;
  profitability: ProfitabilityVerdict;
  cost: CostEstimate;
  throttle: ThrottleDecision;
  explanations: string[];
}

export function decideWork(opts: {
  deviceClass: DeviceClass;
  expectedEarningCentsPerHour: number;
  cpuUsagePct: number;
  foregroundCpuPct: number;
  temperatureC: number | null;
  onBattery: boolean;
  batteryPct: number | null;
  targetMaxCpuPct: number;
  countryCode?: string | null;
  userOverrideRateUsdKwh?: number | null;
  measuredIdleW?: number | null;
  measuredLoadW?: number | null;
  throttle: AdaptiveThrottle;
}): WorkDecision {
  const cost = estimateCost({
    deviceClass: opts.deviceClass,
    utilisationPct: opts.cpuUsagePct,
    countryCode: opts.countryCode,
    userOverrideRateUsdKwh: opts.userOverrideRateUsdKwh,
    measuredIdleW: opts.measuredIdleW,
    measuredLoadW: opts.measuredLoadW
  });
  const profitability = evaluateProfitability({
    earningCentsPerHour: opts.expectedEarningCentsPerHour,
    cost
  });
  const decision = opts.throttle.observe({
    cpu_usage_pct: opts.cpuUsagePct,
    foreground_cpu_pct: opts.foregroundCpuPct,
    temperature_c: opts.temperatureC,
    on_battery: opts.onBattery,
    battery_pct: opts.batteryPct,
    profitable: profitability.profitable,
    margin_cents_per_hour: profitability.margin_cents_per_hour,
    target_max_cpu_pct: opts.targetMaxCpuPct
  });
  const explanations: string[] = [];
  if (!profitability.profitable) {
    explanations.push(
      `unprofitable: earning ${profitability.earning_cents_per_hour.toFixed(4)}¢/hr ≤ cost ${profitability.cost_cents_per_hour.toFixed(4)}¢/hr (+${profitability.safety_buffer_cents_per_hour.toFixed(4)}¢ safety)`
    );
  }
  if (decision.derate_reason) explanations.push(`derate: ${decision.derate_reason}`);
  if (decision.reasons.length > 0) explanations.push(...decision.reasons);
  const should_run =
    profitability.profitable && !decision.pause && decision.workers_allowed > 0;
  return {
    should_run,
    target_cpu_pct: decision.target_cpu_pct,
    workers_allowed: decision.workers_allowed,
    profitability,
    cost,
    throttle: decision,
    explanations
  };
}

// ---------------------------------------------------------------------------
// Live OS telemetry helpers
// ---------------------------------------------------------------------------

export async function readForegroundCpuPct(): Promise<number> {
  // os.cpus() gives cumulative ticks. We diff between two reads.
  const start = sampleCpu();
  await new Promise((r) => setTimeout(r, 250));
  const end = sampleCpu();
  let totalDiff = 0;
  let idleDiff = 0;
  for (let i = 0; i < end.length; i++) {
    const t = end[i].total - start[i].total;
    const idle = end[i].idle - start[i].idle;
    totalDiff += t;
    idleDiff += idle;
  }
  if (totalDiff <= 0) return 0;
  return ((totalDiff - idleDiff) / totalDiff) * 100;
}

function sampleCpu(): { total: number; idle: number }[] {
  return os.cpus().map((c) => {
    const t = c.times;
    return { total: t.user + t.nice + t.sys + t.idle + t.irq, idle: t.idle };
  });
}

export interface BatteryState {
  on_battery: boolean;
  pct: number | null;
}

export async function readBatteryState(): Promise<BatteryState> {
  // We don't import `systeminformation` here to avoid the ~200ms warm-up cost
  // every claim cycle. Read the cheap path; fall back to ac-only.
  // The full agent already calls si.battery() in heartbeat-paths and caches it
  // on globalThis.
  const cached = (globalThis as { __em_battery?: BatteryState }).__em_battery;
  if (cached) return cached;
  return { on_battery: false, pct: null };
}

export function rememberBatteryState(state: BatteryState): void {
  (globalThis as { __em_battery?: BatteryState }).__em_battery = state;
}

// ---------------------------------------------------------------------------
// Earnings/cost ledger (in-memory, flushed via IPC)
// ---------------------------------------------------------------------------

export interface LedgerEntry {
  occurred_at: number;
  earnings_cents: number;
  cost_cents: number;
}

export class EconomicLedger {
  private entries: LedgerEntry[] = [];
  private windowSeconds: number;

  constructor(windowSeconds: number = 30 * 24 * 3600) {
    this.windowSeconds = windowSeconds;
  }

  record(earningsCents: number, costCents: number): LedgerEntry {
    const entry: LedgerEntry = {
      occurred_at: Date.now() / 1000,
      earnings_cents: earningsCents,
      cost_cents: costCents
    };
    this.entries.push(entry);
    const cutoff = entry.occurred_at - this.windowSeconds;
    this.entries = this.entries.filter((e) => e.occurred_at >= cutoff);
    return entry;
  }

  totals(): { earnings_cents: number; cost_cents: number; margin_cents: number } {
    const e = this.entries.reduce((a, x) => a + x.earnings_cents, 0);
    const c = this.entries.reduce((a, x) => a + x.cost_cents, 0);
    return { earnings_cents: e, cost_cents: c, margin_cents: e - c };
  }

  hourlyBuckets(hours: number = 24): Array<{ ts: number; earnings_cents: number; cost_cents: number; margin_cents: number }> {
    const cutoff = Date.now() / 1000 - hours * 3600;
    const buckets = new Map<number, { ts: number; earnings_cents: number; cost_cents: number; margin_cents: number }>();
    for (const e of this.entries) {
      if (e.occurred_at < cutoff) continue;
      const slot = Math.floor(e.occurred_at / 3600);
      const cur = buckets.get(slot) ?? {
        ts: slot * 3600,
        earnings_cents: 0,
        cost_cents: 0,
        margin_cents: 0
      };
      cur.earnings_cents += e.earnings_cents;
      cur.cost_cents += e.cost_cents;
      cur.margin_cents = cur.earnings_cents - cur.cost_cents;
      buckets.set(slot, cur);
    }
    return [...buckets.values()].sort((a, b) => a.ts - b.ts);
  }
}
