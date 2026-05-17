import crypto from "node:crypto";
import pc from "picocolors";
import { api } from "../lib/api.mjs";
import { store } from "../lib/store.mjs";

const CHARSETS = {
  digits: "0123456789",
  lower: "abcdefghijklmnopqrstuvwxyz",
  alpha: "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ",
  alnum: "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789",
  hex: "0123456789abcdef"
};

export function registerJob(program) {
  const cmd = program.command("job").description("Submit / inspect / watch jobs");

  cmd
    .command("hash")
    .description("Submit a hashcrack.range job")
    .requiredOption("--target <hex>", "target hash hex")
    .option("--algo <algorithm>", "sha256 | sha512 | md5 | ntlm", "sha256")
    .option("--salt <salt>", "optional salt")
    .option("--charset <name|literal>", "digits|lower|alpha|alnum|hex or literal string", "lower")
    .option("--min <n>", "min candidate length", "3")
    .option("--max <n>", "max candidate length", "5")
    .option("--chunk <n>", "chunk size (keys per workunit)", "500000")
    .option("--clusters <n>", "target cluster count", "1")
    .option("--budget <usd>", "max spend in USD", "5")
    .option("--runtime <min>", "max runtime minutes", "30")
    .option("--redundancy <n>", "consensus redundancy (default 1 for solo demos)", "1")
    .option("--title <text>", "job title")
    .option("--watch", "watch the job after submitting")
    .action(async (opts) => {
      const state = await store.get();
      const key = state.enterprise?.apiKey;
      if (!key) throw new Error("connect an enterprise key first: `em ent connect <key>`");
      const charset = CHARSETS[opts.charset] ?? opts.charset;

      const body = {
        kind: "hashcrack.range",
        title: opts.title || `hashcrack ${opts.algo} ${opts.min}-${opts.max}`,
        target_cluster_count: Number(opts.clusters),
        target_h100_equivalent: 0.001,
        max_budget_cents: Math.max(100, Math.round(Number(opts.budget) * 100)),
        max_runtime_seconds: Number(opts.runtime) * 60,
        redundancy: Number(opts.redundancy),
        consensus_threshold: 0.66,
        hashcrack_range: {
          algorithm: opts.algo,
          target_hash: String(opts.target).toLowerCase(),
          salt: opts.salt || null,
          charset,
          min_length: Number(opts.min),
          max_length: Number(opts.max),
          chunk_size: Number(opts.chunk)
        },
        isolation_policy: {
          forbid_plaintext: true,
          forbid_keys: true,
          chunk_only: true,
          require_attestation: false,
          encryption: "aes_gcm",
          redact_fields: []
        }
      };

      const job = await api.submitJob(key, body);
      console.log(pc.green("✓ submitted"), pc.bold(job.handle), pc.dim(job.id));
      console.log(
        pc.dim(
          `  workunits=${job.workunit_total} target=${charset.length}^${opts.min}..${opts.max}`
        )
      );

      if (opts.watch) await watchJob(key, job.id);
    });

  cmd
    .command("plain")
    .description("Convenience: hash a known plaintext + submit a hashcrack job for it")
    .requiredOption("--text <plaintext>", "plaintext to hash + immediately try to recover")
    .option("--algo <algorithm>", "sha256 | sha512 | md5 | ntlm", "sha256")
    .option("--charset <name|literal>", "digits|lower|alpha|alnum|hex or literal", "alnum")
    .option("--min <n>", "min length (default = len(text))")
    .option("--max <n>", "max length (default = len(text))")
    .option("--chunk <n>", "chunk size", "500000")
    .option("--watch", "watch after submit", true)
    .action(async (opts) => {
      const algo = opts.algo;
      const text = String(opts.text);
      const target =
        algo === "ntlm"
          ? crypto.createHash("md4").update(Buffer.from(text, "utf16le")).digest("hex")
          : crypto.createHash(algo).update(text, "utf8").digest("hex");

      const min = opts.min ? Number(opts.min) : text.length;
      const max = opts.max ? Number(opts.max) : text.length;
      console.log(
        pc.cyan("•"),
        `target ${algo}("${text}") =`,
        pc.dim(target.slice(0, 16) + "…"),
        pc.dim(`(searching ${opts.charset} len=${min}..${max})`)
      );

      const state = await store.get();
      const key = state.enterprise?.apiKey;
      if (!key) throw new Error("connect an enterprise key first");
      const charset = CHARSETS[opts.charset] ?? opts.charset;

      const body = {
        kind: "hashcrack.range",
        title: `recover "${text}" via ${algo}`,
        target_cluster_count: 1,
        target_h100_equivalent: 0.001,
        max_budget_cents: 200,
        max_runtime_seconds: 600,
        redundancy: 1,
        consensus_threshold: 0.66,
        hashcrack_range: {
          algorithm: algo,
          target_hash: target,
          salt: null,
          charset,
          min_length: min,
          max_length: max,
          chunk_size: Number(opts.chunk)
        },
        isolation_policy: {
          forbid_plaintext: true,
          forbid_keys: true,
          chunk_only: true,
          require_attestation: false,
          encryption: "aes_gcm",
          redact_fields: []
        }
      };
      const job = await api.submitJob(key, body);
      console.log(pc.green("✓ submitted"), pc.bold(job.handle), pc.dim(`workunits=${job.workunit_total}`));
      if (opts.watch !== false) await watchJob(key, job.id);
    });

  cmd
    .command("list")
    .description("List recent jobs")
    .action(async () => {
      const state = await store.get();
      const items = await api.listJobs(state.enterprise.apiKey);
      for (const j of items) {
        const status =
          j.status === "succeeded"
            ? pc.green(j.status.padEnd(10))
            : j.status === "failed" || j.status === "timed_out"
              ? pc.red(j.status.padEnd(10))
              : j.status === "running"
                ? pc.cyan(j.status.padEnd(10))
                : pc.yellow(j.status.padEnd(10));
        console.log(
          `${status} ${pc.dim(j.handle)} ${j.title || ""} ` +
            pc.dim(`${j.workunit_completed}/${j.workunit_total}`)
        );
      }
    });

  cmd
    .command("get <jobId>")
    .description("Show full job detail")
    .action(async (jobId) => {
      const state = await store.get();
      const job = await api.getJob(state.enterprise.apiKey, jobId);
      console.log(JSON.stringify(job, null, 2));
    });

  cmd
    .command("workunits <jobId>")
    .description("List workunits for a job")
    .action(async (jobId) => {
      const state = await store.get();
      const items = await api.listWorkunits(state.enterprise.apiKey, jobId);
      for (const w of items) {
        const status =
          w.status === "succeeded"
            ? pc.green(w.status.padEnd(20))
            : w.status === "failed"
              ? pc.red(w.status.padEnd(20))
              : pc.yellow(w.status.padEnd(20));
        console.log(
          `#${String(w.sequence_no).padStart(3)} ${status} ` +
            `${w.redundancy_satisfied}/${w.redundancy_required} ` +
            pc.dim(`${w.final_result_hash?.slice(0, 12) ?? "—"}`)
        );
      }
    });

  cmd
    .command("watch <jobId>")
    .description("Stream job progress until terminal")
    .action(async (jobId) => {
      const state = await store.get();
      await watchJob(state.enterprise.apiKey, jobId);
    });

  cmd
    .command("cancel <jobId>")
    .description("Cancel a running job")
    .option("--reason <text>", "cancel reason")
    .action(async (jobId, opts) => {
      const state = await store.get();
      const out = await api.cancelJob(state.enterprise.apiKey, jobId, opts.reason);
      console.log(pc.green("✓ cancelled"), out.handle);
    });
}

async function watchJob(apiKey, jobId) {
  let lastLine = "";
  for (let tick = 0; tick < 600; tick++) {
    const job = await api.getJob(apiKey, jobId);
    const pct =
      job.workunit_total > 0
        ? Math.round((job.workunit_completed / job.workunit_total) * 100)
        : 0;
    const bar = renderBar(pct);
    const line =
      `${pc.cyan(job.status.padEnd(10))} ${bar} ` +
      `${job.workunit_completed}/${job.workunit_total} ` +
      pc.dim(`spent=$${(job.spent_cents / 100).toFixed(2)}`);
    if (line !== lastLine) {
      process.stdout.write(`\r${line}        `);
      lastLine = line;
    }
    if (["succeeded", "failed", "cancelled", "timed_out"].includes(job.status)) {
      process.stdout.write("\n");
      const wus = await api.listWorkunits(apiKey, jobId);
      const hits = [];
      for (const w of wus) {
        if (w.status === "succeeded" && w.final_result_hash) {
          hits.push(w);
        }
      }
      console.log(pc.green(`✓ ${job.status}`));
      // Pull each hit workunit's attempt result through the admin job detail
      // (no public endpoint for raw attempt result, so approximate via final_result on workunit detail)
      const detail = await api.getJob(apiKey, jobId);
      console.log(
        pc.dim(
          `  spent=$${(detail.spent_cents / 100).toFixed(2)} paid=$${(detail.paid_to_users_cents / 100).toFixed(2)}`
        )
      );
      // Show any candidates we can find via the workunits list (only the hash, but that signals success)
      for (const w of wus) {
        if (w.status === "succeeded") {
          console.log(
            pc.dim(`  #${w.sequence_no}`),
            pc.green("succeeded"),
            pc.dim(`hash=${w.final_result_hash?.slice(0, 16)}…`)
          );
        }
      }
      return;
    }
    await new Promise((r) => setTimeout(r, 1500));
  }
  process.stdout.write("\n");
  console.log(pc.yellow("watch timeout — re-run `em job watch <id>`"));
}

function renderBar(pct, width = 24) {
  const filled = Math.round((pct / 100) * width);
  return `[${pc.green("█".repeat(filled))}${pc.dim("░".repeat(width - filled))}] ${String(pct).padStart(3)}%`;
}
