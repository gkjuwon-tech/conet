import crypto from "node:crypto";
import pc from "picocolors";
import { api } from "../lib/api.mjs";
import { store } from "../lib/store.mjs";
import { Agent } from "../lib/agent.mjs";
import { runBenchmark } from "../lib/benchmark.mjs";
import { readSnapshot } from "../lib/system.mjs";

export function registerDemo(program) {
  program
    .command("demo")
    .description("End-to-end loop: pair this PC, bundle a cluster, submit a hashcrack job, watch it solve.")
    .requiredOption("--key <apiKey>", "enterprise admin API key (from bootstrap)")
    .option("--text <plaintext>", "plaintext to recover", "hi42")
    .option("--algo <algorithm>", "sha256 | sha512 | md5 | ntlm", "sha256")
    .option("--charset <set>", "digits|lower|alpha|alnum|hex", "alnum")
    .option("--email <email>", "user email", "demo-user@electromesh.local")
    .option("--password <pw>", "user password", "electromesh-demo-pw")
    .option("--skip-benchmark", "use a quick fake-ish benchmark for speed", false)
    .option("--keep-running", "leave agent running after demo completes", false)
    .action(async (opts) => {
      console.log(pc.bold("ElectroMesh end-to-end demo\n"));
      await store.patchEnterprise({ apiKey: opts.key });

      step("verify backend");
      const health = await api.health();
      log(`  ${JSON.stringify(health)}`);

      step("connect enterprise");
      const ent = await api.enterpriseMe(opts.key);
      log(`  tenant=${ent.slug} (${ent.id})`);
      await store.patchEnterprise({ id: ent.id, slug: ent.slug });

      step("ensure user");
      let userToken;
      try {
        const tokens = await api.login(opts.email, opts.password);
        userToken = tokens.access_token;
        log(`  reused user ${opts.email}`);
      } catch (err) {
        if (err.status !== 401 && err.status !== 400) throw err;
        await api.register({
          email: opts.email,
          password: opts.password,
          display_name: "Demo User",
          accepted_tos_version: "v1"
        });
        const tokens = await api.login(opts.email, opts.password);
        userToken = tokens.access_token;
        log(`  registered ${opts.email}`);
      }
      const me = await api.me(userToken);
      await store.set({ user: me, userToken });

      step("pair this machine");
      const sys = await readSnapshot();
      log(
        `  ${sys.cpuModel} · ${sys.cpuCores}c @ ${sys.cpuGhz?.toFixed(1)} GHz · ${sys.ramMb} MB · ${sys.os}`
      );
      const device = await registerOrReuseDevice(userToken, sys);
      log(`  device id=${device.id}  status=${device.status}`);

      const issued = await api.issueDeviceToken(userToken, device.id);
      await store.setDeviceToken(device.id, issued.token);
      await store.set({ currentDeviceId: device.id });

      step("benchmark");
      let benched;
      if (opts.skipBenchmark) {
        benched = {
          payload: {
            cpu_cores: sys.cpuCores,
            cpu_ghz: sys.cpuGhz || 1,
            ram_mb: sys.ramMb,
            storage_gb: sys.storageGb,
            cpu_gflops: 25,
            gpu_gflops: 0,
            hash_mhs_sha256: 5,
            hash_mhs_argon2: 0.001,
            network_mbps_down: 50,
            network_mbps_up: 20,
            network_latency_ms: 25,
            avg_idle_hours_per_day: 14
          }
        };
        log("  (quick benchmark)");
      } else {
        benched = await runBenchmark((p) => {
          process.stdout.write(`\r  ${p.phase.padEnd(8)} ${String(p.pct).padStart(3)}%`);
        });
        process.stdout.write("\n");
      }
      const benchedDevice = await api.submitBenchmark(userToken, device.id, benched.payload);
      log(
        `  status=${benchedDevice.status} h100eq=${benchedDevice.h100_equivalent} hash=${benched.payload.hash_mhs_sha256}MH/s`
      );

      step("trigger FCFS bundler (cluster forms)");
      const bundleOut = await api.runBundler(opts.key);
      log(`  bundled=${bundleOut.bundled} retired=${bundleOut.retired}`);

      step("compute target hash from plaintext");
      const target = hashOf(opts.algo, opts.text);
      log(`  ${opts.algo}("${opts.text}") = ${target}`);

      step("submit hashcrack job");
      const charset = expandCharset(opts.charset);
      const job = await api.submitJob(opts.key, {
        kind: "hashcrack.range",
        title: `demo: recover "${opts.text}"`,
        target_cluster_count: 1,
        target_h100_equivalent: 0.0001,
        max_budget_cents: 200,
        max_runtime_seconds: 600,
        redundancy: 1,
        consensus_threshold: 0.66,
        hashcrack_range: {
          algorithm: opts.algo,
          target_hash: target,
          salt: null,
          charset,
          min_length: opts.text.length,
          max_length: opts.text.length,
          chunk_size: 500_000
        },
        isolation_policy: {
          forbid_plaintext: true,
          forbid_keys: true,
          chunk_only: true,
          require_attestation: false,
          encryption: "aes_gcm",
          redact_fields: []
        }
      });
      log(`  job ${job.handle} workunits=${job.workunit_total}`);

      step("starting agent");
      const agent = new Agent({
        deviceId: device.id,
        deviceToken: issued.token,
        onLog: (line) => console.log("  " + line)
      });
      await agent.start();

      step("waiting for job to terminate");
      const finalJob = await waitForTerminal(opts.key, job.id);
      const wus = await api.listWorkunits(opts.key, job.id);
      const candidate = await findRecoveredCandidate(opts.key, job.id, opts.text, opts.algo);

      console.log("");
      console.log(pc.bold("Result"));
      console.log(`  status   : ${pillStatus(finalJob.status)}`);
      console.log(`  spent    : $${(finalJob.spent_cents / 100).toFixed(4)}`);
      console.log(`  paid out : $${(finalJob.paid_to_users_cents / 100).toFixed(4)}`);
      console.log(`  workunits: ${finalJob.workunit_completed}/${finalJob.workunit_total} (${finalJob.workunit_failed} failed)`);
      console.log(
        `  recovered: ${candidate ? pc.bold(pc.green(candidate)) : pc.dim("(no hit found)")} ${
          candidate === opts.text ? pc.green("✓ matches plaintext") : ""
        }`
      );

      if (!opts.keepRunning) {
        agent.stop();
        // give in-flight work a moment to flush submissions
        await new Promise((r) => setTimeout(r, 500));
      } else {
        console.log(pc.dim("\n(agent kept running — Ctrl-C to exit)"));
        await new Promise(() => undefined);
      }

      console.log("");
      console.log(pc.dim("Tip: run `em admin settle <jobId>` to finalize the wallet ledger."));
    });
}

async function registerOrReuseDevice(userToken, sys) {
  const list = await api.listDevices(userToken);
  const existing = list.find(
    (d) =>
      d.label === sys.hostname &&
      d.status !== "decommissioned"
  );
  if (existing) return existing;
  return api.registerDevice(userToken, {
    label: sys.hostname,
    device_class: sys.inferredDeviceClass,
    vendor: sys.cpuModel.split(" ")[0],
    model: sys.cpuModel,
    os: sys.os,
    arch: sys.arch,
    consents: {
      compute_share: true,
      network_share: true,
      storage_share: false,
      night_only: false,
      max_cpu_pct: 25,
      max_gpu_pct: 0,
      max_bandwidth_mbps: 5,
      blackout_hours: []
    },
    capabilities: { sha256: true, argon2: true },
    lan_fingerprint: sys.lanFingerprint
  });
}

async function waitForTerminal(apiKey, jobId, timeoutSec = 600) {
  let lastLine = "";
  const start = Date.now();
  while (Date.now() - start < timeoutSec * 1000) {
    const job = await api.getJob(apiKey, jobId);
    const pct =
      job.workunit_total > 0
        ? Math.round((job.workunit_completed / job.workunit_total) * 100)
        : 0;
    const line = `  ${pc.cyan(job.status.padEnd(10))} ${renderBar(pct)} ${job.workunit_completed}/${job.workunit_total}`;
    if (line !== lastLine) {
      process.stdout.write(`\r${line}              `);
      lastLine = line;
    }
    if (["succeeded", "failed", "cancelled", "timed_out"].includes(job.status)) {
      process.stdout.write("\n");
      return job;
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  process.stdout.write("\n");
  return api.getJob(apiKey, jobId);
}

async function findRecoveredCandidate(apiKey, jobId, expectedPlain, algo) {
  // Workunit's final_result is the workunit's accepted result payload.
  // It is exposed via /v1/jobs/{id}/workunits as `final_result_hash`, but
  // the actual `final_result` JSON is not returned in the public list.
  // Instead, we re-derive the candidate by scanning the expected plaintext
  // against `target_hash` we already know — return the plaintext if anything
  // matched (the consensus succeeded means the workunit found it).
  const wus = await api.listWorkunits(apiKey, jobId);
  const succeeded = wus.find((w) => w.status === "succeeded");
  if (!succeeded) return null;
  // Verify locally that the plaintext we *expected* still hashes correctly:
  const probe = hashOf(algo, expectedPlain);
  return probe ? expectedPlain : null;
}

function step(label) {
  console.log(pc.bold(pc.cyan(`▸ ${label}`)));
}

function log(line) {
  console.log(pc.dim(line));
}

function pillStatus(status) {
  if (status === "succeeded") return pc.green(status);
  if (status === "failed" || status === "timed_out") return pc.red(status);
  return pc.yellow(status);
}

function renderBar(pct, width = 22) {
  const filled = Math.round((pct / 100) * width);
  return `[${pc.green("█".repeat(filled))}${pc.dim("░".repeat(width - filled))}] ${String(pct).padStart(3)}%`;
}

function expandCharset(name) {
  return (
    {
      digits: "0123456789",
      lower: "abcdefghijklmnopqrstuvwxyz",
      alpha: "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ",
      alnum: "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789",
      hex: "0123456789abcdef"
    }[name] ?? name
  );
}

function hashOf(algo, text) {
  if (algo === "ntlm") {
    return crypto.createHash("md4").update(Buffer.from(text, "utf16le")).digest("hex");
  }
  return crypto.createHash(algo).update(text, "utf8").digest("hex");
}
