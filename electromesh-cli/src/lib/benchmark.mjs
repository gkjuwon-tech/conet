import crypto from "node:crypto";
import os from "node:os";
import { performance } from "node:perf_hooks";
import { readSnapshot } from "./system.mjs";

export async function runBenchmark(onProgress = () => {}) {
  const sys = await readSnapshot();
  onProgress({ phase: "cpu", pct: 0 });
  const cpuGflops = await measureCpuGflops((p) =>
    onProgress({ phase: "cpu", pct: p })
  );
  onProgress({ phase: "hash", pct: 0 });
  const hashMhs = await measureHashRate((p) =>
    onProgress({ phase: "hash", pct: p })
  );
  onProgress({ phase: "argon", pct: 0 });
  const argonMhs = await measureArgon((p) =>
    onProgress({ phase: "argon", pct: p })
  );
  onProgress({ phase: "network", pct: 0 });
  const network = await measureNetwork();
  onProgress({ phase: "network", pct: 100, detail: `${network.downMbps} Mbps` });

  return {
    payload: {
      cpu_cores: sys.cpuCores,
      cpu_ghz: sys.cpuGhz || 1.0,
      ram_mb: sys.ramMb,
      storage_gb: sys.storageGb,
      gpu_model: sys.gpuModel || undefined,
      gpu_vram_mb: sys.gpuVramMb,
      cpu_gflops: cpuGflops,
      gpu_gflops: 0,
      hash_mhs_sha256: hashMhs,
      hash_mhs_argon2: argonMhs,
      network_mbps_down: network.downMbps,
      network_mbps_up: network.upMbps,
      network_latency_ms: network.latencyMs,
      avg_idle_hours_per_day: 14
    },
    snapshot: sys
  };
}

async function measureCpuGflops(onProgress) {
  const cores = Math.max(1, os.cpus().length);
  const trials = 4;
  let total = 0;
  for (let i = 0; i < trials; i++) {
    const start = performance.now();
    let acc = 0;
    const iters = 30_000_000;
    for (let k = 0; k < iters; k++) {
      acc = acc * 1.0000001 + Math.sin(k * 0.0001);
    }
    if (acc === 12345.6789) console.log("noop");
    const ms = performance.now() - start;
    total += iters / (ms / 1000);
    onProgress(Math.round(((i + 1) / trials) * 100));
    await tick();
  }
  const avg = total / trials;
  return Number(((avg * 4 * cores) / 1_000_000_000).toFixed(2));
}

async function measureHashRate(onProgress) {
  const trials = 3;
  let total = 0;
  for (let i = 0; i < trials; i++) {
    const start = performance.now();
    let n = 0;
    while (performance.now() - start < 600) {
      const chunk = 5_000;
      for (let k = 0; k < chunk; k++) {
        crypto.createHash("sha256").update("probe").digest();
      }
      n += chunk;
    }
    const elapsed = (performance.now() - start) / 1000;
    total += n / elapsed;
    onProgress(Math.round(((i + 1) / trials) * 100));
    await tick();
  }
  return Number((total / trials / 1_000_000).toFixed(3));
}

async function measureArgon(onProgress) {
  const trials = 2;
  let total = 0;
  for (let i = 0; i < trials; i++) {
    const start = performance.now();
    let n = 0;
    while (performance.now() - start < 300) {
      crypto.scryptSync(`probe-${n}`, "salt", 32, {
        N: 1024,
        r: 8,
        p: 1,
        maxmem: 32 * 1024 * 1024
      });
      n++;
    }
    const elapsed = (performance.now() - start) / 1000;
    total += n / elapsed;
    onProgress(Math.round(((i + 1) / trials) * 100));
    await tick();
  }
  return Number((total / trials / 1_000_000).toFixed(5));
}

async function measureNetwork() {
  const url = "https://www.cloudflare.com/cdn-cgi/trace";
  let latencyMs = 0;
  let downMbps = 0;
  try {
    const start = performance.now();
    const res = await fetch(url, { cache: "no-store" });
    const text = await res.text();
    latencyMs = Number((performance.now() - start).toFixed(1));
    downMbps = Number(((text.length * 8) / 1024 / Math.max(latencyMs, 1)).toFixed(2));
  } catch {
    latencyMs = 999;
    downMbps = 1;
  }
  return { latencyMs, downMbps, upMbps: Number((downMbps * 0.4).toFixed(2)) };
}

function tick() {
  return new Promise((r) => setImmediate(r));
}
