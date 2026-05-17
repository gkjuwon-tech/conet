import pc from "picocolors";
import { api } from "../lib/api.mjs";
import { store } from "../lib/store.mjs";
import { readSnapshot } from "../lib/system.mjs";
import { runBenchmark } from "../lib/benchmark.mjs";

export function registerDevice(program) {
  const cmd = program.command("device").description("Manage devices owned by the signed-in user");

  cmd
    .command("list")
    .description("List my registered devices")
    .action(async () => {
      const state = await store.get();
      const items = await api.listDevices(state.userToken);
      if (!items.length) {
        console.log(pc.dim("(no devices yet — run `em device pair`)"));
        return;
      }
      for (const d of items) {
        const me = state.currentDeviceId === d.id ? pc.green("●") : pc.dim("○");
        console.log(
          `${me} ${pc.bold(d.label || d.handle)}  ${pc.dim(d.device_class)}  ` +
            `${pc.cyan(d.status)}  ${pc.dim(`h100eq=${d.h100_equivalent}`)}`
        );
        console.log(pc.dim(`   id=${d.id}  handle=${d.handle}`));
      }
    });

  cmd
    .command("inspect")
    .description("Show this machine's hardware snapshot (no network calls beyond a probe)")
    .action(async () => {
      const sys = await readSnapshot();
      console.log(JSON.stringify(sys, null, 2));
    });

  cmd
    .command("pair")
    .description("Detect this machine, register it, run a benchmark, store the agent token")
    .option("--label <label>", "human label for this device")
    .option("--class <deviceClass>", "override inferred device class")
    .option("--max-cpu <pct>", "max CPU share %", "20")
    .option("--no-gpu", "disable GPU usage")
    .option("--night-only", "only allow work between 0–6am")
    .action(async (opts) => {
      const state = await store.get();
      if (!state.userToken) throw new Error("sign in first: `em login` or `em register`");

      const sys = await readSnapshot();
      const label = opts.label || sys.hostname;
      const deviceClass = opts.class || sys.inferredDeviceClass;
      const maxCpu = Number(opts.maxCpu);

      console.log(pc.cyan("• detected:"), label, pc.dim(`(${deviceClass})`));
      console.log(
        pc.dim(
          `  ${sys.cpuModel} · ${sys.cpuCores}c @ ${sys.cpuGhz?.toFixed(1)} GHz · ${sys.ramMb} MB RAM · ${sys.gpuModel ?? "no-gpu"}`
        )
      );

      const device = await api.registerDevice(state.userToken, {
        label,
        device_class: deviceClass,
        vendor: sys.cpuModel.split(" ")[0],
        model: sys.cpuModel,
        os: sys.os,
        arch: sys.arch,
        consents: {
          compute_share: true,
          network_share: true,
          storage_share: false,
          night_only: !!opts.nightOnly,
          max_cpu_pct: maxCpu,
          max_gpu_pct: opts.gpu === false ? 0 : maxCpu,
          max_bandwidth_mbps: 5,
          blackout_hours: []
        },
        capabilities: {
          sha256: true,
          argon2: true,
          ml_inference: false,
          fhe: false,
          mpc: false,
          render: false,
          secure_enclave: false,
          tpm: false
        },
        lan_fingerprint: sys.lanFingerprint
      });
      console.log(pc.green("✓ registered"), pc.dim(device.id));

      const issued = await api.issueDeviceToken(state.userToken, device.id);
      await store.setDeviceToken(device.id, issued.token);
      await store.set({ currentDeviceId: device.id });
      console.log(pc.green("✓ device token saved"), pc.dim(`expires_in=${issued.expires_in}s`));

      console.log(pc.cyan("• benchmarking…"));
      const { payload, snapshot } = await runBenchmark((p) => {
        process.stdout.write(`\r  ${p.phase.padEnd(8)} ${String(p.pct).padStart(3)}%`);
      });
      process.stdout.write("\n");

      const updated = await api.submitBenchmark(state.userToken, device.id, payload);
      console.log(
        pc.green("✓ benchmark submitted"),
        pc.dim(
          `cpu=${payload.cpu_gflops}gf hash=${payload.hash_mhs_sha256}MH/s h100eq=${updated.h100_equivalent}`
        )
      );
      console.log(pc.green("✓ status:"), pc.cyan(updated.status));
      console.log(pc.dim(`(snapshot lan_fp=${snapshot.lanFingerprint.slice(0, 12)}…)`));
    });

  cmd
    .command("use <deviceId>")
    .description("Make this device the active one for `em agent run`")
    .action(async (deviceId) => {
      await store.set({ currentDeviceId: deviceId });
      console.log(pc.green("✓ active device:"), deviceId);
    });

  cmd
    .command("benchmark [deviceId]")
    .description("Re-benchmark the active (or given) device")
    .action(async (deviceId) => {
      const state = await store.get();
      const id = deviceId || state.currentDeviceId;
      if (!id) throw new Error("no active device — pass <deviceId> or run `em device pair`");
      const { payload } = await runBenchmark((p) => {
        process.stdout.write(`\r  ${p.phase.padEnd(8)} ${String(p.pct).padStart(3)}%`);
      });
      process.stdout.write("\n");
      const updated = await api.submitBenchmark(state.userToken, id, payload);
      console.log(pc.green("✓ updated"), pc.dim(`h100eq=${updated.h100_equivalent}`));
    });
}
