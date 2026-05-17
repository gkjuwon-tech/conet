import { exec } from "node:child_process";
import { promisify } from "node:util";
import os from "node:os";
import crypto from "node:crypto";

const execP = promisify(exec);

const OUI_VENDOR_HINTS: Record<string, { vendor: string; deviceClass: string }> = {
  "70:5d:cc": { vendor: "ASUSTek", deviceClass: "router" },
  "20:3d:bd": { vendor: "Apple", deviceClass: "phone" },
  "f0:18:98": { vendor: "Apple", deviceClass: "phone" },
  "9c:35:eb": { vendor: "Apple", deviceClass: "phone" },
  "a4:c3:61": { vendor: "Apple", deviceClass: "tablet" },
  "d4:ff:1a": { vendor: "Liteon", deviceClass: "laptop" },
  "80:96:98": { vendor: "Sony", deviceClass: "smart_tv" },
  "00:1f:bb": { vendor: "Samsung", deviceClass: "smart_tv" },
  "ec:1f:72": { vendor: "Samsung", deviceClass: "smart_tv" },
  "00:1d:25": { vendor: "Samsung", deviceClass: "fridge" },
  "fc:f1:36": { vendor: "Samsung", deviceClass: "phone" },
  "04:d3:b0": { vendor: "Intel", deviceClass: "laptop" },
  "00:15:5d": { vendor: "Microsoft Hyper-V", deviceClass: "other_iot" },
  "b8:27:eb": { vendor: "Raspberry Pi", deviceClass: "other_iot" },
  "dc:a6:32": { vendor: "Raspberry Pi", deviceClass: "other_iot" },
  "ec:fa:bc": { vendor: "Espressif", deviceClass: "smart_bulb" },
  "84:f3:eb": { vendor: "Espressif", deviceClass: "smart_plug" },
  "cc:50:e3": { vendor: "Espressif", deviceClass: "smart_bulb" },
  "70:03:9f": { vendor: "Tuya", deviceClass: "smart_plug" },
  "00:09:b0": { vendor: "Onkyo", deviceClass: "smart_tv" }
};

export interface LanDevice {
  ip: string;
  mac: string;
  hostname: string | null;
  vendor: string;
  device_class: string;
  label: string;
  randomized_mac: boolean;
  lan_fingerprint: string;
}

export interface ScanResult {
  ourIp: string | null;
  ourMac: string | null;
  gatewayMac: string | null;
  lanFingerprint: string | null;
  subnet: string | null;
  iface: string | null;
  devices: LanDevice[];
}

export type ScanProgress =
  | { type: "info"; message: string }
  | { type: "ping"; done: number; total: number }
  | { type: "device"; device: LanDevice }
  | { type: "done"; result: ScanResult };

function isLocallyAdministered(mac: string): boolean {
  const firstByte = parseInt(mac.replace(/[^0-9a-f]/gi, "").slice(0, 2), 16);
  return (firstByte & 0x02) !== 0;
}

function isMulticast(mac: string): boolean {
  const firstByte = parseInt(mac.replace(/[^0-9a-f]/gi, "").slice(0, 2), 16);
  return (firstByte & 0x01) !== 0;
}

function lookupVendor(mac: string): { vendor: string; deviceClass: string } {
  const norm = mac.toLowerCase().replace(/-/g, ":");
  const prefix = norm.split(":").slice(0, 3).join(":");
  if (OUI_VENDOR_HINTS[prefix]) return OUI_VENDOR_HINTS[prefix];
  if (isLocallyAdministered(mac)) {
    return { vendor: "Privacy-randomized", deviceClass: "phone" };
  }
  return { vendor: "Unknown", deviceClass: "other_iot" };
}

function detectLocalSubnet(): {
  subnet: string;
  ourIp: string;
  ourMac: string;
  iface: string;
} | null {
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const addr of ifaces[name] ?? []) {
      if (addr.family !== "IPv4" || addr.internal) continue;
      if (addr.address.startsWith("172.") || addr.address.startsWith("169.254."))
        continue;
      const parts = addr.address.split(".").map(Number);
      const [a, b, c] = parts;
      const subnet = `${a}.${b}.${c}.`;
      return { subnet, ourIp: addr.address, ourMac: addr.mac, iface: name };
    }
  }
  return null;
}

async function pingSweep(
  subnet: string,
  onProgress: (done: number, total: number) => void
): Promise<void> {
  const total = 254;
  let completed = 0;
  const tasks: Promise<unknown>[] = [];
  for (let i = 1; i <= total; i++) {
    const ip = `${subnet}${i}`;
    const isWin = process.platform === "win32";
    const cmd = isWin ? `ping -n 1 -w 100 ${ip}` : `ping -c 1 -W 1 ${ip}`;
    tasks.push(
      execP(cmd, { windowsHide: true })
        .then(
          () => true,
          () => false
        )
        .finally(() => {
          completed += 1;
          onProgress(completed, total);
        })
    );
  }
  await Promise.all(tasks);
}

async function readArp(): Promise<{ ip: string; mac: string }[]> {
  const isWin = process.platform === "win32";
  const cmd = isWin ? "arp -a" : "arp -an";
  let stdout = "";
  try {
    const result = await execP(cmd, { encoding: "buffer", windowsHide: true });
    stdout = (result.stdout as Buffer).toString("latin1");
  } catch {
    return [];
  }
  const rows: { ip: string; mac: string }[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    const macMatch = line.match(/([0-9a-fA-F]{2}[-:]){5}[0-9a-fA-F]{2}/);
    const ipMatch = line.match(/(\d{1,3}\.){3}\d{1,3}/);
    if (!macMatch || !ipMatch) continue;
    const mac = macMatch[0].toLowerCase().replace(/-/g, ":");
    const ip = ipMatch[0];
    if (isMulticast(mac)) continue;
    if (mac === "ff:ff:ff:ff:ff:ff" || mac === "00:00:00:00:00:00") continue;
    rows.push({ ip, mac });
  }
  return rows;
}

async function reverseDnsHostname(ip: string): Promise<string | null> {
  try {
    const { stdout } = await execP(`nslookup ${ip}`, {
      windowsHide: true,
      timeout: 1500
    });
    const m = (stdout as string).match(/[Nn]ame:\s*(\S+)/);
    return m?.[1] ?? null;
  } catch {
    return null;
  }
}

export async function discoverLanDevices(
  onProgress: (event: ScanProgress) => void
): Promise<ScanResult> {
  const net = detectLocalSubnet();
  const empty: ScanResult = {
    ourIp: null,
    ourMac: null,
    gatewayMac: null,
    lanFingerprint: null,
    subnet: null,
    iface: null,
    devices: []
  };
  if (!net) {
    onProgress({
      type: "info",
      message: "no usable IPv4 interface — connect to WiFi first"
    });
    onProgress({ type: "done", result: empty });
    return empty;
  }
  onProgress({ type: "info", message: `our address: ${net.ourIp} (${net.iface})` });
  onProgress({
    type: "info",
    message: `subnet: ${net.subnet}0/24 — sweeping with ICMP`
  });

  await pingSweep(net.subnet, (done, total) => {
    if (done % 16 === 0 || done === total)
      onProgress({ type: "ping", done, total });
  });

  onProgress({ type: "info", message: "reading ARP table" });
  const rows = await readArp();
  const onSubnet = rows.filter(
    (r) => r.ip.startsWith(net.subnet) && r.ip !== net.ourIp
  );

  const gatewayRow = onSubnet.find((r) => r.ip === `${net.subnet}1`);
  const gatewayMac = gatewayRow?.mac ?? null;
  const lanFingerprint = crypto
    .createHash("sha256")
    .update(`${net.ourMac}|${gatewayMac ?? net.subnet + "0/24"}`)
    .digest("hex")
    .slice(0, 48);

  onProgress({ type: "info", message: `lan fingerprint: ${lanFingerprint}` });

  const enriched: LanDevice[] = [];
  for (const row of onSubnet) {
    const vendorInfo = lookupVendor(row.mac);
    const hostname = await reverseDnsHostname(row.ip);
    const dev: LanDevice = {
      ip: row.ip,
      mac: row.mac,
      hostname,
      vendor: vendorInfo.vendor,
      device_class: vendorInfo.deviceClass,
      label: hostname ?? `${vendorInfo.vendor} @ ${row.ip}`,
      lan_fingerprint: lanFingerprint,
      randomized_mac: isLocallyAdministered(row.mac)
    };
    enriched.push(dev);
    onProgress({ type: "device", device: dev });
  }

  const result: ScanResult = {
    ourIp: net.ourIp,
    ourMac: net.ourMac,
    gatewayMac,
    lanFingerprint,
    subnet: net.subnet + "0/24",
    iface: net.iface,
    devices: enriched
  };
  onProgress({ type: "done", result });
  return result;
}

export function syntheticBenchmark(deviceClass: string) {
  const profiles: Record<
    string,
    { cpu_gflops: number; hash: number; mem: number; idle: number }
  > = {
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
