/* -------------------------------------------------------------------------
 * `em gateway` — AdminGateway: one-click multi-device approval.
 *
 *   em gateway refresh                  Re-scan LAN and rebuild queue
 *   em gateway queue                    Show pending approvals
 *   em gateway approve --all            Approve every eligible device
 *   em gateway approve --ip <ip>        Approve a single device
 *   em gateway cloud-login --vendor X   Record vendor cloud login
 * ------------------------------------------------------------------------- */

import pc from "picocolors";
import { api as rawApi } from "../lib/api.mjs";
import { store } from "../lib/store.mjs";

const api = { raw: (o) => rawApi.raw({ timeoutMs: 60_000, ...o }) };

function statusColor(s) {
  return {
    pending:         pc.dim(s),
    approving:       pc.yellow(s),
    approved:        pc.green(s),
    cached:          pc.green(s),
    needs_bootstrap: pc.cyan(s),
    failed:          pc.red(s),
    unsupported:     pc.gray(s),
  }[s] ?? s;
}

function connectorIcon(c) {
  return {
    lg_webos:       "📺",
    roku_ecp:       "📦",
    chromecast_dial:"🎬",
    captive_byod:   "📱",
  }[c] ?? "❓";
}

function printQueue(snap) {
  console.log(pc.bold(`\n  AdminGateway — ${snap.total} devices in queue\n`));
  console.log(pc.dim(`  cloud logins: ${(snap.cloud_logins || []).join(", ") || "(none)"}`));
  console.log(pc.dim(`  portal_base:  ${snap.portal_base_url}`));
  const counts = Object.entries(snap.by_status || {}).map(
    ([k, v]) => `${statusColor(k)}=${v}`,
  ).join("  ");
  console.log(`  status: ${counts}\n`);
  for (const row of snap.queue || []) {
    const icon = connectorIcon(row.connector);
    const conn = row.connector ? pc.cyan(row.connector.padEnd(16)) : pc.dim("(none)".padEnd(16));
    console.log(
      `  ${icon}  ${pc.bold(row.device_ip.padEnd(16))}  ${row.vendor.padEnd(22)}  ` +
      `${row.device_type.padEnd(12)}  ${conn}  ${statusColor(row.status)}`
    );
    if (row.bootstrap_action) {
      console.log(pc.yellow(`        ↳ ${row.bootstrap_action}`));
    }
    if (row.last_error) {
      console.log(pc.red(`        ↳ err: ${row.last_error.slice(0, 100)}`));
    }
  }
  console.log();
}

export function registerGateway(program) {
  const cmd = program
    .command("gateway")
    .description("AdminGateway: central one-click device approval");

  cmd
    .command("refresh")
    .description("Re-scan the LAN and rebuild the queue")
    .action(async () => {
      const state = await store.get();
      const snap = await api.raw({
        method: "POST", path: "/v1/claim/gateway/refresh",
        token: state.userToken,
      });
      printQueue(snap);
    });

  cmd
    .command("queue")
    .description("Show the current approval queue")
    .action(async () => {
      const state = await store.get();
      const snap = await api.raw({
        method: "GET", path: "/v1/claim/gateway/queue",
        token: state.userToken,
      });
      printQueue(snap);
    });

  cmd
    .command("approve")
    .description("Approve devices — '한 번 클릭으로 다 점유'")
    .option("--all", "Approve every eligible device")
    .option("--ip <ip>", "Approve a single device by IP")
    .option("--portal-base <url>", "Override portal base URL", "http://192.168.0.22")
    .action(async (opts) => {
      const state = await store.get();
      const body = {
        portal_base_url: opts.portalBase,
        device_ips: opts.all ? null : (opts.ip ? [opts.ip] : null),
      };
      if (!opts.all && !opts.ip) {
        console.error(pc.red("specify --all or --ip <ip>"));
        process.exit(1);
      }
      console.log(pc.bold(opts.all
        ? "\n🚀 approving ALL devices in queue...\n"
        : `\n🚀 approving ${opts.ip}...\n`));
      const r = await api.raw({
        method: "POST", path: "/v1/claim/gateway/approve",
        token: state.userToken, body,
      });
      console.log(pc.bold(`  attempted: ${r.attempted}`));
      for (const [ip, res] of Object.entries(r.results || {})) {
        const mark = res.ok ? pc.green("✓") : pc.red("✗");
        const extra = res.bootstrap_action ? pc.yellow(` ↳ ${res.bootstrap_action}`) : "";
        console.log(`  ${mark} ${ip.padEnd(16)} ${(res.connector || "-").padEnd(16)} ` +
                    `${statusColor(res.status || "?")}${res.error ? pc.red(" "+res.error.slice(0,60)) : ""}${extra}`);
      }
      if (r.snapshot) printQueue(r.snapshot);
    });

  cmd
    .command("cloud-login")
    .description("Record that you signed into a vendor cloud (LG, Google, etc.)")
    .requiredOption("--vendor <vendor>", "vendor name: google_cast | lg_thinq | samsung_smartthings | ...")
    .option("--note <text>", "free-text note (we DO NOT store tokens here)")
    .action(async (opts) => {
      const state = await store.get();
      const r = await api.raw({
        method: "POST", path: "/v1/claim/gateway/cloud-login",
        token: state.userToken,
        body: { vendor: opts.vendor, info: { note: opts.note || "" } },
      });
      console.log(pc.green("✓ cloud login recorded"), pc.dim(JSON.stringify(r.cloud_logins)));
    });
}
