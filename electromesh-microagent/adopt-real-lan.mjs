// Spawn microagents that ADOPT real LAN-paired devices.
// Discovers every device the gateway has registered for this LAN claim, then
// spawns one microagent process per device that issues itself a device_token
// and runs the agent loop on behalf of that real LAN identity.
//
// Result: each ARP-discovered host on the user's actual Wi-Fi has a real
// process producing real workunit results — no synthetic benchmarks, no
// gateway running compute "on behalf of" anyone.

import { spawn } from "node:child_process";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import pc from "picocolors";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const cliState = JSON.parse(
  fs.readFileSync(path.join(os.homedir(), ".electromesh", "state.json"), "utf8")
);
const userToken = cliState.userToken;
if (!userToken) throw new Error("not logged in to em CLI");

// Pull current device list — only consider auto-detected LAN devices, NOT the
// 8 microagent-class devices we already simulate. Heuristic: skip devices
// whose label starts with "Living Room TV ", "Synology ", … (simulation set).
const SIM_PREFIXES = [
  "Living Room TV ",
  "PlayStation 5 ",
  "Synology ",
  "Smart Fridge ",
  "Edge Router (",
  "Smart Microwave ",
  "Smart Washer ",
  "Smart Dryer ",
  "TestTV",
  "Test TV",
  "Hue Bulb",
  "Yeelight",
  "TP-Link Plug",
  "Aqara Plug",
  "iPad ",
  "Old Pixel ",
  "Roomba ",
  "Apple TV",
  "Sonos"
];
function isSimulated(label) {
  return SIM_PREFIXES.some((p) => label?.startsWith(p));
}

const res = await fetch("http://localhost:8080/v1/devices", {
  headers: { Authorization: `Bearer ${userToken}` }
});
const devices = await res.json();
const realLanDevices = devices.filter(
  (d) => !isSimulated(d.label) && d.status !== "decommissioned"
);

console.log(
  pc.bold(pc.cyan(`🌐 adopting ${realLanDevices.length} real LAN devices as microagents`))
);
for (const d of realLanDevices) {
  console.log(
    `  ${pc.green("●")} ${pc.bold(d.label.padEnd(40))} ${pc.dim(d.device_class.padEnd(12))} ${pc.dim(d.id)}`
  );
}

const microagentScript = path.join(__dirname, "microagent.mjs");
const children = [];
let port = 4900;

for (const d of realLanDevices) {
  const child = spawn(
    process.execPath,
    [
      microagentScript,
      "--port",
      String(port),
      "--class",
      d.device_class,
      "--label",
      d.label,
      "--user-token",
      userToken,
      "--adopt-device-id",
      d.id
    ],
    { stdio: ["ignore", "pipe", "pipe"] }
  );
  child.stdout.on("data", (c) => process.stdout.write(c));
  child.stderr.on("data", (c) => process.stderr.write(c));
  children.push({ device: d, port, child });
  port++;
}

console.log(pc.dim(`spawned ${children.length} microagents on ports 4900..${port - 1}`));

const shutdown = () => {
  for (const c of children) c.child.kill("SIGINT");
  setTimeout(() => process.exit(0), 800);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
