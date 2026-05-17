import crypto from "node:crypto";
import { performance } from "node:perf_hooks";
import os from "node:os";
import { readSystemSnapshot } from "./system-info";
import type { BenchmarkSubmit } from "./api-client";

export interface BenchmarkProgress {
  phase: "cpu" | "hash" | "network" | "argon" | "done";
  pct: number;
  detail?: string;
}

export type BenchmarkProgressFn = (p: BenchmarkProgress) => void;

export async function runFullBenchmark(
  onProgress: BenchmarkProgressFn,
  opts: { networkProbeUrl?: string } = {}
): Promise<BenchmarkSubmit> {
  const sys = await readSystemSnapshot();
  onProgress({ phase: "cpu", pct: 0, detail: "Warming CPU" });
  const cpuGflops = await measureCpuGflops((p) =>
    onProgress({ phase: "cpu", pct: p, detail: "Estimating FP throughput" })
  );

  onProgress({ phase: "hash", pct: 0, detail: "Hashing burst" });
  const hashMhs = await measureHashRate((p) =>
    onProgress({ phase: "hash", pct: p, detail: "SHA-256 micro-burst" })
  );

  onProgress({ phase: "argon", pct: 0, detail: "Memory-hard sample" });
  const argonMhs = await measureArgonish((p) =>
    onProgress({ phase: "argon", pct: p, detail: "Memory-hard simulator" })
  );

  onProgress({ phase: "network", pct: 0, detail: "Probing latency" });
  const network = await measureNetwork(opts.networkProbeUrl);
  onProgress({ phase: "network", pct: 100, detail: `${network.downMbps} Mbps` });

  const idleHours = guessIdleHoursPerDay(sys.platform);

  const submit: BenchmarkSubmit = {
    cpu_cores: sys.cpuCores,
    cpu_ghz: sys.cpuGhz,
    ram_mb: sys.ramMb,
    storage_gb: sys.storageGb,
    gpu_model: sys.gpuModel ?? undefined,
    gpu_vram_mb: sys.gpuVramMb,
    cpu_gflops: cpuGflops,
    gpu_gflops: 0,
    hash_mhs_sha256: hashMhs,
    hash_mhs_argon2: argonMhs,
    network_mbps_down: network.downMbps,
    network_mbps_up: network.upMbps,
    network_latency_ms: network.latencyMs,
    avg_idle_hours_per_day: idleHours
  };
  onProgress({ phase: "done", pct: 100, detail: "Benchmark complete" });
  return submit;
}

async function measureCpuGflops(onProgress: (pct: number) => void): Promise<number> {
  const cores = Math.max(1, os.cpus().length);
  const trials = 6;
  let total = 0;
  for (let i = 0; i < trials; i++) {
    const ops = await tightFloatLoop(50_000_000);
    total += ops;
    onProgress(Math.round(((i + 1) / trials) * 100));
    await tick();
  }
  const avgOps = total / trials;
  const gflopsPerCore = (avgOps * 4) / 1_000_000_000;
  return Number((gflopsPerCore * cores).toFixed(2));
}

async function tightFloatLoop(iters: number): Promise<number> {
  const start = performance.now();
  let acc = 0.0;
  for (let i = 0; i < iters; i++) {
    acc = acc * 1.0000001 + Math.sin(i * 0.0001);
  }
  if (acc === 12345.6789) console.log("dont optimize me away");
  const ms = performance.now() - start;
  return iters / (ms / 1000);
}

async function measureHashRate(onProgress: (pct: number) => void): Promise<number> {
  const trials = 4;
  const buf = Buffer.alloc(64, 0xab);
  let totalRate = 0;
  for (let i = 0; i < trials; i++) {
    const startedAt = performance.now();
    let hashed = 0;
    while (performance.now() - startedAt < 700) {
      const chunk = 5_000;
      for (let k = 0; k < chunk; k++) {
        crypto.createHash("sha256").update(buf).digest();
      }
      hashed += chunk;
    }
    const elapsed = (performance.now() - startedAt) / 1000;
    totalRate += hashed / elapsed;
    onProgress(Math.round(((i + 1) / trials) * 100));
    await tick();
  }
  return Number((totalRate / trials / 1_000_000).toFixed(3));
}

async function measureArgonish(onProgress: (pct: number) => void): Promise<number> {
  const trials = 3;
  let totalRate = 0;
  for (let i = 0; i < trials; i++) {
    const startedAt = performance.now();
    let count = 0;
    while (performance.now() - startedAt < 350) {
      crypto.scryptSync(`probe-${count}`, "salt-em", 32, {
        N: 1024,
        r: 8,
        p: 1,
        maxmem: 32 * 1024 * 1024
      });
      count++;
    }
    const elapsed = (performance.now() - startedAt) / 1000;
    totalRate += count / elapsed;
    onProgress(Math.round(((i + 1) / trials) * 100));
    await tick();
  }
  return Number((totalRate / trials / 1_000_000).toFixed(5));
}

async function measureNetwork(probeUrl?: string): Promise<{
  latencyMs: number;
  downMbps: number;
  upMbps: number;
}> {
  const url = probeUrl ?? "https://www.cloudflare.com/cdn-cgi/trace";
  let latencyMs = 0;
  let downMbps = 0;
  try {
    const start = performance.now();
    const res = await fetch(url, { headers: { "Cache-Control": "no-cache" } });
    const text = await res.text();
    latencyMs = Number((performance.now() - start).toFixed(1));
    downMbps = Number(((text.length * 8) / 1024 / Math.max(latencyMs, 1)).toFixed(2));
  } catch {
    latencyMs = 999;
    downMbps = 0;
  }
  return { latencyMs, downMbps, upMbps: Number((downMbps * 0.4).toFixed(2)) };
}

function guessIdleHoursPerDay(platform: string): number {
  if (platform === "darwin" || platform === "linux") return 14;
  return 12;
}

function tick(): Promise<void> {
  return new Promise((r) => setImmediate(r));
}
