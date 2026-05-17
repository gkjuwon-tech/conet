import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { snapshot } from "./system-info";

export interface BenchmarkResult {
  hashrate_mhs: number;
  ram_mb: number;
  power_w: number;
  cpu_model: string;
  cpu_cores: number;
  duration_ms: number;
}

export const benchmarkEvents = new EventEmitter();

/**
 * Quick local sha256 hash benchmark — measures host hashrate by hashing
 * a 4MB buffer N times, reporting MH/s.
 */
export async function runBenchmark(): Promise<BenchmarkResult> {
  const sys = await snapshot();
  benchmarkEvents.emit("progress", { phase: "warmup", pct: 5, detail: "Warming up CPU…" });
  // warmup pass
  const warmupBuf = Buffer.alloc(1024 * 1024, 0xAB);
  for (let i = 0; i < 64; i++) createHash("sha256").update(warmupBuf).digest();

  benchmarkEvents.emit("progress", { phase: "hashing", pct: 25, detail: "Hashing 256MB across passes…" });
  const buf = Buffer.alloc(4 * 1024 * 1024, 0xCD);
  const passes = 64;
  const startNs = process.hrtime.bigint();
  for (let i = 0; i < passes; i++) {
    createHash("sha256").update(buf).digest();
    if (i % 8 === 0) {
      const pct = 25 + Math.round((i / passes) * 60);
      benchmarkEvents.emit("progress", { phase: "hashing", pct, detail: `Pass ${i + 1}/${passes}` });
    }
  }
  const elapsedNs = process.hrtime.bigint() - startNs;
  const elapsedMs = Number(elapsedNs / 1_000_000n);
  const bytes = buf.length * passes;
  // hashrate in MH/s — assume each hash op covers one block (64 bytes input means ~bytes/64 ops)
  const hashCount = bytes / 64;
  const seconds = elapsedMs / 1000;
  const mhs = Math.round(((hashCount / seconds) / 1_000_000) * 100) / 100;

  benchmarkEvents.emit("progress", { phase: "done", pct: 100, detail: `~${mhs} MH/s` });
  return {
    hashrate_mhs: mhs,
    ram_mb: sys.ramTotalMb,
    power_w: Math.max(20, Math.round(sys.cpuLogical * 8)),
    cpu_model: sys.cpuModel,
    cpu_cores: sys.cpuLogical,
    duration_ms: elapsedMs
  };
}
