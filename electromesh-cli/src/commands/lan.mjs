import pc from "picocolors";
import readline from "node:readline/promises";
import { stdin as procIn, stdout as procOut } from "node:process";
import { discoverLanDevices } from "../lib/lan-scan.mjs";
import { api } from "../lib/api.mjs";
import { store } from "../lib/store.mjs";

const CLASS_LABEL = {
  smart_bulb: "Bulb",
  smart_plug: "Plug",
  smart_tv: "TV",
  fridge: "Fridge",
  washer: "Washer",
  dryer: "Dryer",
  microwave: "Microwave",
  router: "Router",
  nas: "NAS",
  desktop: "Desktop",
  laptop: "Laptop",
  console: "Console",
  phone: "Phone",
  tablet: "Tablet",
  gpu_rig: "GPU rig",
  other_iot: "IoT"
};

function logPretty(stream, level, payload) {
  if (level === "device") {
    const d = payload;
    const tag = pc.cyan(`[${CLASS_LABEL[d.device_class] ?? d.device_class}]`);
    stream.write(
      `  ${tag.padEnd(18)} ${pc.dim(d.ip.padEnd(16))} ${pc.dim(d.mac.padEnd(19))} ${
        d.randomized_mac ? pc.yellow("rand-mac ") : "         "
      }${pc.bold(d.label)}\n`
    );
    return;
  }
  if (level === "progress") {
    stream.write(`  ${pc.dim(payload)}\r`);
    return;
  }
  if (level === "error") {
    stream.write(`${pc.red("✗")} ${payload}\n`);
    return;
  }
  stream.write(`  ${pc.dim(payload)}\n`);
}

async function scan() {
  process.stdout.write(pc.bold("LAN scan\n"));
  const result = await discoverLanDevices({
    onLog: (level, payload) => logPretty(process.stdout, level, payload)
  });
  process.stdout.write(`\n${pc.green("✓")} ${result.devices.length} hosts discovered\n`);
  return result;
}

async function ensureClaim(scanResult, state) {
  // Compute the LAN fingerprint of this gateway. Every paired device on this
  // LAN will use the same fingerprint, so we claim once.
  const lanFp =
    scanResult.devices.find((d) => d.lan_fingerprint)?.lan_fingerprint ?? null;
  if (!lanFp) throw new Error("no LAN fingerprint available — refusing to register");

  const claims = await api.raw({
    method: "GET",
    path: "/v1/lan-claims",
    token: state.userToken
  });
  const verified = claims.find(
    (c) => c.lan_fingerprint === lanFp && c.status === "verified" && c.is_active
  );
  if (verified) {
    procOut.write(
      `${pc.green("✓")} LAN already claimed by you (${pc.dim(verified.id)})\n`
    );
    return verified;
  }

  procOut.write(
    `\n${pc.yellow("⚠")} this LAN is not claimed yet — running OTP claim flow\n`
  );
  procOut.write(
    pc.dim(
      "  ElectroMesh requires email-OTP proof of LAN ownership before pairing.\n" +
        "  Anyone could otherwise hijack public-WiFi devices in a Starbucks etc.\n"
    )
  );
  return await runClaimFlow(state, lanFp, scanResult);
}

async function runClaimFlow(state, lanFp, scanResult) {
  const reqBody = {
    lan_fingerprint: lanFp,
    label: scanResult.devices[0]?.hostname ?? `LAN ${scanResult.ourIp}`,
    advertised_subnet: scanResult.ourIp
      ? scanResult.ourIp.split(".").slice(0, 3).join(".") + ".0/24"
      : null,
    gateway_mac:
      scanResult.devices.find((d) => d.device_class === "router")?.mac ?? null
  };
  const claim = await api.raw({
    method: "POST",
    path: "/v1/lan-claims",
    token: state.userToken,
    body: reqBody
  });
  procOut.write(
    `\n${pc.cyan("▸")} OTP requested ${pc.dim("(check the registered email)")}\n`
  );
  if (claim.delivered_otp_dev) {
    procOut.write(
      `  ${pc.yellow("DEV-MODE OTP:")} ${pc.bold(claim.delivered_otp_dev)} ${pc.dim(
        "— delivered via email in production. Automating entry..."
      )}\n`
    );
    const verified = await api.raw({
      method: "POST",
      path: "/v1/lan-claims/verify",
      token: state.userToken,
      body: { lan_fingerprint: lanFp, otp: claim.delivered_otp_dev }
    });
    procOut.write(`${pc.green("✓ LAN claimed")} ${pc.dim(verified.id)}\n`);
    return verified;
  }

  const rl = readline.createInterface({ input: procIn, output: procOut });
  let verified = null;
  for (let attempt = 1; attempt <= 5; attempt++) {
    const otp = (await rl.question(`  enter OTP (attempt ${attempt}/5): `)).trim();
    if (!otp) continue;
    try {
      verified = await api.raw({
        method: "POST",
        path: "/v1/lan-claims/verify",
        token: state.userToken,
        body: { lan_fingerprint: lanFp, otp }
      });
      break;
    } catch (err) {
      procOut.write(`  ${pc.red("✗")} ${err.message}\n`);
    }
  }
  rl.close();
  if (!verified) {
    throw new Error("OTP verification failed");
  }
  procOut.write(`${pc.green("✓ LAN claimed")} ${pc.dim(verified.id)}\n`);
  procOut.write(
    pc.dim(
      `  grace_until=${verified.grace_until} — disputes from real owners will reverse pairings\n`
    )
  );
  return verified;
}

async function claimOnly() {
  const state = await store.get();
  if (!state.userToken) {
    console.error(pc.red("✗ not logged in. run `em login` first."));
    process.exit(1);
  }
  const scanResult = await scan();
  return await ensureClaim(scanResult, state);
}

async function pairAll(opts = {}) {
  const state = await store.get();
  if (!state.userToken) {
    console.error(pc.red("✗ not logged in. run `em login` or `em register` first."));
    process.exit(1);
  }

  const scanResult = await scan();

  await ensureClaim(scanResult, state);

  const devices = scanResult.devices.filter((d) => {
    if (opts.skipRandomized && d.randomized_mac) return false;
    if (opts.skipRouter && d.device_class === "router") return false;
    return true;
  });

  process.stdout.write(`\n${pc.bold("Registering")} ${devices.length} ${pc.bold("devices...")}\n`);
  const registered = [];
  for (const d of devices) {
    const body = {
      label: d.label,
      device_class: d.device_class,
      vendor: d.vendor,
      model: `${d.vendor} (${d.mac})`,
      os: d.hostname ?? "unknown",
      arch: "unknown",
      consents: {
        compute_share: true,
        network_share: true,
        storage_share: false,
        night_only: false,
        max_cpu_pct: 10,
        max_gpu_pct: 0,
        max_bandwidth_mbps: 2,
        blackout_hours: []
      },
      capabilities: {
        sha256: ["laptop", "desktop", "console", "gpu_rig", "phone", "tablet", "nas"].includes(
          d.device_class
        ),
        argon2: false,
        ml_inference: false,
        fhe: false,
        mpc: false,
        render: false,
        secure_enclave: ["phone", "tablet"].includes(d.device_class),
        tpm: false
      },
      lan_fingerprint: d.lan_fingerprint
    };

    try {
      const dev = await api.raw({
        method: "POST",
        path: "/v1/devices/register",
        token: state.userToken,
        body
      });
      process.stdout.write(
        `  ${pc.green("✓")} ${pc.bold(d.label.padEnd(28))} → ${pc.dim(dev.id)} (${dev.status})\n`
      );

      // Submit a synthetic benchmark proportional to the device class so the
      // backend treats lightweight devices as lightweight.
      const bench = syntheticBenchmark(d.device_class);
      try {
        const benched = await api.raw({
          method: "POST",
          path: `/v1/devices/${dev.id}/benchmark`,
          token: state.userToken,
          body: bench
        });
        process.stdout.write(
          `    ${pc.dim(`benchmarked: h100eq=${benched.h100_equivalent.toFixed(6)} hash=${benched.hash_mhs_sha256.toFixed(2)} MH/s`)}\n`
        );
      } catch (err) {
        process.stdout.write(`    ${pc.yellow("⚠")} ${pc.dim(`benchmark skipped: ${err.message}`)}\n`);
      }

      registered.push(dev);
    } catch (err) {
      process.stdout.write(`  ${pc.red("✗")} ${d.label}: ${err.message}\n`);
    }
  }

  process.stdout.write(`\n${pc.green("✓")} registered ${registered.length}/${devices.length}\n`);

  // Pick a "primary" device to run the agent against — prefer the local PC
  // (we can't actually run worker_threads on a fridge, so the PC handles
  // compute on behalf of light devices).
  const primary =
    registered.find((r) => r.device_class === "laptop" || r.device_class === "desktop") ||
    registered[0];
  const currentState = await store.get();
  if (primary && !currentState.currentDeviceId) {
    await store.set({ currentDeviceId: primary.id });
    process.stdout.write(`${pc.dim("set primary device:")} ${primary.id} (${primary.label})\n`);
  }

  return registered;
}

function syntheticBenchmark(deviceClass) {
  // Realistic-shape benchmarks per class so the bundler/pricer does not
  // over-charge for an iPhone like it would for a 4090.
  const profiles = {
    smart_bulb: { cpu_gflops: 0.04, hash: 0.001, mem: 16, idle: 22 },
    smart_plug: { cpu_gflops: 0.05, hash: 0.001, mem: 32, idle: 22 },
    smart_tv: { cpu_gflops: 8, hash: 14, mem: 2048, idle: 16 },
    fridge: { cpu_gflops: 0.4, hash: 0.3, mem: 256, idle: 23.5 },
    washer: { cpu_gflops: 0.2, hash: 0.15, mem: 128, idle: 22 },
    dryer: { cpu_gflops: 0.2, hash: 0.15, mem: 128, idle: 22 },
    microwave: { cpu_gflops: 0.1, hash: 0.05, mem: 64, idle: 23.5 },
    router: { cpu_gflops: 1.2, hash: 3.5, mem: 256, idle: 24 },
    nas: { cpu_gflops: 10, hash: 25, mem: 4096, idle: 23 },
    desktop: { cpu_gflops: 220, hash: 600, mem: 16000, idle: 12 },
    laptop: { cpu_gflops: 80, hash: 180, mem: 8000, idle: 14 },
    console: { cpu_gflops: 70, hash: 500, mem: 8000, idle: 16 },
    phone: { cpu_gflops: 30, hash: 70, mem: 4096, idle: 16 },
    tablet: { cpu_gflops: 38, hash: 80, mem: 4096, idle: 18 },
    gpu_rig: { cpu_gflops: 380, hash: 5500, mem: 32000, idle: 22 },
    other_iot: { cpu_gflops: 0.4, hash: 0.25, mem: 128, idle: 22 }
  };
  const p = profiles[deviceClass] ?? profiles.other_iot;
  return {
    cpu_cores: 2,
    cpu_ghz: 1.2,
    ram_mb: p.mem,
    storage_gb: 8,
    gpu_vram_mb: 0,
    cpu_gflops: p.cpu_gflops,
    gpu_gflops: 0,
    hash_mhs_sha256: p.hash,
    hash_mhs_argon2: p.hash * 0.001,
    network_mbps_down: 80,
    network_mbps_up: 30,
    network_latency_ms: 8,
    avg_idle_hours_per_day: p.idle
  };
}

export function registerLan(program) {
  const lan = program
    .command("lan")
    .description("Discover and pair devices on the same LAN as this gateway");

  lan
    .command("scan")
    .description("Ping-sweep + ARP read; print every host found on the local /24")
    .action(async () => {
      await scan();
    });

  lan
    .command("claim")
    .description(
      "Prove ownership of this LAN via email OTP — required before pairing."
    )
    .action(async () => {
      try {
        await claimOnly();
      } catch (err) {
        console.error(pc.red(`✗ ${err.message}`));
        process.exit(1);
      }
    });

  lan
    .command("claims")
    .description("List your LAN claims and their status")
    .action(async () => {
      const state = await store.get();
      if (!state.userToken) {
        console.error(pc.red("✗ not logged in"));
        process.exit(1);
      }
      const list = await api.raw({
        method: "GET",
        path: "/v1/lan-claims",
        token: state.userToken
      });
      if (list.length === 0) {
        procOut.write(pc.dim("no claims yet — run `em lan claim`\n"));
        return;
      }
      for (const c of list) {
        const color =
          c.status === "verified"
            ? pc.green
            : c.status === "pending_otp"
              ? pc.yellow
              : pc.red;
        procOut.write(
          `  ${color(c.status.padEnd(14))} ${pc.dim(
            c.lan_fingerprint.slice(0, 16) + "…"
          )} ${pc.bold(c.label ?? "")}\n`
        );
      }
    });

  lan
    .command("dispute <lanFingerprint>")
    .description(
      "Dispute a LAN claim held by another user (you must be on that LAN)."
    )
    .option("--reason <text>", "human reason", "ownership conflict")
    .action(async (fp, opts) => {
      const state = await store.get();
      if (!state.userToken) {
        console.error(pc.red("✗ not logged in"));
        process.exit(1);
      }
      const res = await api.raw({
        method: "POST",
        path: "/v1/lan-claims/dispute",
        token: state.userToken,
        body: { lan_fingerprint: fp, reason: opts.reason }
      });
      procOut.write(
        `${pc.green("✓")} disputed ${res.disputed} active claims on this LAN\n`
      );
    });

  lan
    .command("pair")
    .description("Pair a specific device type manually")
    .option("--type <type>", "Device type (e.g. mobile, fridge, tv, console, desktop, nas, washer, router, bulb, plug, microwave, bot, camera, soundbar, stb)")
    .option("--pin <pin>", "PIN code for fridge pairing")
    .option("--local-auth", "Simulate Local Network Auth for TV")
    .option("--fake-dns", "Simulate Fake DNS setup for Console")
    .option("--otp <otp>", "OTP for Desktop headless node")
    .option("--docker", "Docker mode for NAS")
    .action(async (opts) => {
      const state = await store.get();
      if (!state.userToken) {
        console.error(pc.red("✗ not logged in"));
        process.exit(1);
      }
      
      const scanResult = await scan();
      const lanFp = scanResult.devices.find((d) => d.lan_fingerprint)?.lan_fingerprint;
      if (!lanFp) {
         console.error(pc.red("✗ no LAN fingerprint found"));
         process.exit(1);
      }

      if (opts.type === "mobile") {
         try {
            const dev = await api.raw({
               method: "POST",
               path: "/v1/pairing/mobile",
               token: state.userToken,
               body: { lan_fingerprint: lanFp, label: "Test Mobile Agent", device_class: "phone" }
            });
            procOut.write(`${pc.green("✓")} paired mobile device: ${pc.bold(dev.device.id)}\n`);
            procOut.write(`  ${pc.dim("token:")} ${dev.token}\n`);
         } catch (err) {
            console.error(pc.red(`✗ pairing failed: ${err.message}`));
         }
      } else if (opts.type === "fridge") {
         if (!opts.pin) {
            console.error(pc.red("✗ --pin is required for fridge pairing"));
            process.exit(1);
         }
         try {
            const dev = await api.raw({
               method: "POST",
               path: "/v1/pairing/fridge/submit-pin",
               token: state.userToken,
               body: { pin: opts.pin, label: "My Smart Fridge" }
            });
            procOut.write(`${pc.green("✓")} paired smart fridge: ${pc.bold(dev.device.id)}\n`);
         } catch (err) {
            console.error(pc.red(`✗ pairing failed: ${err.message}`));
         }
      } else if (opts.type === "tv") {
         if (!opts.localAuth) {
            console.error(pc.red("✗ --local-auth flag is required to simulate phone authentication for TV"));
            process.exit(1);
         }
         try {
            const dev = await api.raw({
               method: "POST",
               path: "/v1/pairing/tv/local-auth",
               token: state.userToken,
               body: { lan_fingerprint: lanFp, label: "Living Room TV" }
            });
            procOut.write(`${pc.green("✓")} paired smart TV: ${pc.bold(dev.device.id)}\n`);
         } catch (err) {
            console.error(pc.red(`✗ pairing failed: ${err.message}`));
         }
      } else if (opts.type === "console") {
         if (!opts.fakeDns) {
            console.error(pc.red("✗ --fake-dns flag is required for console pairing simulation"));
            process.exit(1);
         }
         try {
            const dev = await api.raw({
               method: "POST",
               path: "/v1/pairing/console/fake-dns",
               token: state.userToken,
               body: { lan_fingerprint: lanFp, label: "Living Room Console" }
            });
            procOut.write(`${pc.green("✓")} paired game console via fake DNS: ${pc.bold(dev.device.id)}\n`);
         } catch (err) {
            console.error(pc.red(`✗ pairing failed: ${err.message}`));
         }
      } else if (opts.type === "desktop") {
         if (!opts.otp) {
            console.error(pc.red("✗ --otp flag is required for desktop/laptop headless pairing"));
            process.exit(1);
         }
         try {
            const dev = await api.raw({
               method: "POST",
               path: "/v1/pairing/desktop/otp-auth",
               token: state.userToken,
               body: { lan_fingerprint: lanFp, label: "My Headless Node", otp: opts.otp }
            });
            procOut.write(`${pc.green("✓")} paired headless desktop node: ${pc.bold(dev.device.id)}\n`);
         } catch (err) {
            console.error(pc.red(`✗ pairing failed: ${err.message}`));
         }
      } else if (opts.type === "nas") {
         if (!opts.docker) {
            console.error(pc.red("✗ --docker flag is required for NAS pairing"));
            process.exit(1);
         }
         try {
            const dev = await api.raw({
               method: "POST",
               path: "/v1/pairing/nas/docker",
               token: state.userToken,
               body: { lan_fingerprint: lanFp, label: "My NAS Server" }
            });
            procOut.write(`${pc.green("✓")} paired NAS via Docker: ${pc.bold(dev.device.id)}\n`);
         } catch (err) {
            console.error(pc.red(`✗ pairing failed: ${err.message}`));
         }
      } else if (opts.type === "washer") {
         try {
            const dev = await api.raw({
               method: "POST",
               path: "/v1/pairing/washer",
               token: state.userToken,
               body: { lan_fingerprint: lanFp, label: "My Smart Washer" }
            });
            procOut.write(`${pc.green("✓")} paired smart washer/dryer: ${pc.bold(dev.device.id)}\n`);
         } catch (err) {
            console.error(pc.red(`✗ pairing failed: ${err.message}`));
         }
      } else if (opts.type === "router") {
         try {
            const dev = await api.raw({
               method: "POST",
               path: "/v1/pairing/router",
               token: state.userToken,
               body: { lan_fingerprint: lanFp, label: "OpenWrt Router" }
            });
            procOut.write(`${pc.green("✓")} paired router via curl/sh: ${pc.bold(dev.device.id)}\n`);
         } catch (err) {
            console.error(pc.red(`✗ pairing failed: ${err.message}`));
         }
      } else if (opts.type === "bulb") {
         try {
            const dev = await api.raw({
               method: "POST",
               path: "/v1/pairing/bulb",
               token: state.userToken,
               body: { lan_fingerprint: lanFp, label: "My Smart Bulb" }
            });
            procOut.write(`${pc.green("✓")} paired smart bulb via local broadcast: ${pc.bold(dev.device.id)}\n`);
         } catch (err) {
            console.error(pc.red(`✗ pairing failed: ${err.message}`));
         }
      } else if (opts.type === "plug") {
         try {
            const dev = await api.raw({
               method: "POST",
               path: "/v1/pairing/plug",
               token: state.userToken,
               body: { lan_fingerprint: lanFp, label: "My Smart Plug" }
            });
            procOut.write(`${pc.green("✓")} paired smart plug via Matter bridge: ${pc.bold(dev.device.id)}\n`);
         } catch (err) {
            console.error(pc.red(`✗ pairing failed: ${err.message}`));
         }
      } else if (opts.type === "microwave") {
         try {
            const dev = await api.raw({
               method: "POST",
               path: "/v1/pairing/microwave",
               token: state.userToken,
               body: { lan_fingerprint: lanFp, label: "My Smart Microwave" }
            });
            procOut.write(`${pc.green("✓")} paired microwave oven: ${pc.bold(dev.device.id)}\n`);
         } catch (err) {
            console.error(pc.red(`✗ pairing failed: ${err.message}`));
         }
      } else if (opts.type === "bot") {
         try {
            const dev = await api.raw({
               method: "POST",
               path: "/v1/pairing/bot",
               token: state.userToken,
               body: { lan_fingerprint: lanFp, label: "My Robot Vacuum" }
            });
            procOut.write(`${pc.green("✓")} paired robot vacuum (docked): ${pc.bold(dev.device.id)}\n`);
         } catch (err) {
            console.error(pc.red(`✗ pairing failed: ${err.message}`));
         }
      } else if (opts.type === "camera") {
         try {
            const dev = await api.raw({
               method: "POST",
               path: "/v1/pairing/camera",
               token: state.userToken,
               body: { lan_fingerprint: lanFp, label: "My Home Camera" }
            });
            procOut.write(`${pc.green("✓")} paired home camera: ${pc.bold(dev.device.id)}\n`);
         } catch (err) {
            console.error(pc.red(`✗ pairing failed: ${err.message}`));
         }
      } else if (opts.type === "soundbar") {
         try {
            const dev = await api.raw({
               method: "POST",
               path: "/v1/pairing/soundbar",
               token: state.userToken,
               body: { lan_fingerprint: lanFp, label: "My Soundbar" }
            });
            procOut.write(`${pc.green("✓")} paired soundbar: ${pc.bold(dev.device.id)}\n`);
         } catch (err) {
            console.error(pc.red(`✗ pairing failed: ${err.message}`));
         }
      } else if (opts.type === "stb") {
         try {
            const dev = await api.raw({
               method: "POST",
               path: "/v1/pairing/stb",
               token: state.userToken,
               body: { lan_fingerprint: lanFp, label: "My Set-top Box" }
            });
            procOut.write(`${pc.green("✓")} paired set-top box: ${pc.bold(dev.device.id)}\n`);
         } catch (err) {
            console.error(pc.red(`✗ pairing failed: ${err.message}`));
         }
      } else {
         console.error(pc.yellow(`⚠ pairing for type '${opts.type}' not implemented yet`));
      }
    });

  lan
    .command("pair-all")
    .description(
      "Scan + register every detected device under the current user (requires verified LAN claim)"
    )
    .option("--skip-randomized", "skip phones with privacy-randomized MACs")
    .option("--skip-router", "skip the gateway/router itself")
    .action(async (opts) => {
      try {
        await pairAll(opts);
      } catch (err) {
        console.error(pc.red(`✗ ${err.message}`));
        process.exit(1);
      }
    });
}
