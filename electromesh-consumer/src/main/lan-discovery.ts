/**
 * Client-side LAN discovery. Runs entirely in the Electron main process so
 * we don't rely on the dockerised backend (which can't see the user's
 * physical LAN). The host machine has direct interface access; we ping-sweep
 * the local /24, then read the OS ARP table, then reverse-DNS the survivors.
 *
 * Why not the backend?
 *   The conet backend ships in a container with the default bridge network,
 *   so its ARP table only sees other containers — never the user's TV,
 *   phone, printer. Every device shows up as zero from inside the
 *   container, and the wizard ends on "Found 0 devices on your LAN" even
 *   though there are six things on the desk.
 */

import { createHash } from "node:crypto";
import { promisify } from "node:util";
import { execFile as _execFile } from "node:child_process";
import { networkInterfaces, platform as osPlatform } from "node:os";
import { lookup as dnsLookup, reverse as dnsReverse } from "node:dns";
import { promises as dns } from "node:dns";

const execFile = promisify(_execFile);
const resolveLookup = promisify(dnsLookup);

export interface ScannedDevice {
  ip: string;
  mac: string;
  hostname: string | null;
  vendor: string;
  device_class: string;
  label: string;
  randomized_mac: boolean;
  lan_fingerprint: string;
  last_seen_at: string;
  match_kind: "arp" | "ping+arp" | "self";
  is_self: boolean;
}

export interface DiscoveryProgress {
  phase: string;
  pct: number;
  count?: number;
  detail?: string;
}

export interface ScanResult {
  count: number;
  items: ScannedDevice[];
  lan_fingerprint: string;
  gateway_ip: string;
  gateway_mac: string;
  subnet: string;
  scanned_at: string;
}

type ProgressFn = (p: DiscoveryProgress) => void;

// ── Minimal OUI / vendor table — only the prefixes that actually carry
// signal in a consumer LAN. Anything not in the table renders as the raw
// OUI; the user can still read the IP/hostname and decide.
const VENDOR_PREFIXES: Record<string, string> = {
  "00:1a:11": "Google",
  "00:1c:b3": "Apple",
  "00:1d:fe": "Apple",
  "00:0c:29": "VMware",
  "00:50:56": "VMware",
  "00:0d:3a": "Microsoft",
  "00:0e:08": "Cisco",
  "00:23:6c": "Apple",
  "00:25:00": "Apple",
  "00:26:08": "Apple",
  "00:26:bb": "Apple",
  "00:26:b0": "Apple",
  "08:00:27": "VirtualBox",
  "10:9a:dd": "Apple",
  "14:10:9f": "Apple",
  "18:b4:30": "Nest",
  "1c:1a:c0": "Apple",
  "1c:b3:c9": "Apple",
  "20:c9:d0": "Apple",
  "28:e7:cf": "Apple",
  "30:90:ab": "Apple",
  "30:f7:c5": "Apple",
  "34:08:bc": "Apple",
  "34:15:9e": "Apple",
  "34:c0:59": "Apple",
  "38:c9:86": "Apple",
  "3c:07:54": "Apple",
  "3c:15:c2": "Apple",
  "3c:2e:f9": "Apple",
  "40:30:04": "Apple",
  "40:33:1a": "Apple",
  "40:b3:95": "Apple",
  "44:00:10": "Apple",
  "44:d8:84": "Apple",
  "48:43:7c": "Apple",
  "48:60:bc": "Apple",
  "48:74:6e": "Apple",
  "4c:8d:79": "Apple",
  "50:f5:da": "Apple",
  "54:26:96": "Apple",
  "54:e4:3a": "Apple",
  "58:55:ca": "Apple",
  "58:b0:35": "Apple",
  "5c:96:9d": "Apple",
  "5c:f9:38": "Apple",
  "60:33:4b": "Apple",
  "60:c5:47": "Apple",
  "60:f4:45": "Apple",
  "64:b9:e8": "Apple",
  "68:5b:35": "Apple",
  "68:96:7b": "Apple",
  "6c:40:08": "Apple",
  "70:73:cb": "Apple",
  "70:de:e2": "Apple",
  "74:e2:f5": "Apple",
  "78:31:c1": "Apple",
  "78:7e:61": "Apple",
  "7c:11:be": "Apple",
  "7c:6d:62": "Apple",
  "84:b1:53": "Apple",
  "88:1f:a1": "Apple",
  "8c:7c:92": "Apple",
  "90:b0:ed": "Apple",
  "98:b8:e3": "Apple",
  "a4:5e:60": "Apple",
  "a8:20:66": "Apple",
  "ac:bc:32": "Apple",
  "b8:78:2e": "Apple",
  "b8:e8:56": "Apple",
  "bc:67:78": "Apple",
  "c4:b3:01": "Apple",
  "c8:bc:c8": "Apple",
  "cc:78:5f": "Apple",
  "d0:a6:37": "Apple",
  "d4:9a:20": "Apple",
  "dc:2b:61": "Apple",
  "e0:b9:ba": "Apple",
  "e0:f8:47": "Apple",
  "e4:8b:7f": "Apple",
  "ec:35:86": "Apple",
  "f0:18:98": "Apple",
  "f0:b4:79": "Apple",
  "f0:db:e2": "Apple",
  "f4:5c:89": "Apple",
  "fc:e9:98": "Apple",
  "ac:cf:5c": "Amazon",
  "44:65:0d": "Amazon",
  "f0:81:73": "Amazon",
  "00:21:cc": "Samsung",
  "1c:5a:3e": "Samsung",
  "20:13:e0": "Samsung",
  "30:cd:a7": "Samsung",
  "34:14:5f": "Samsung",
  "38:0a:94": "Samsung",
  "38:aa:3c": "Samsung",
  "5c:0a:5b": "Samsung",
  "5c:f6:dc": "Samsung",
  "64:b3:10": "Samsung",
  "78:bd:bc": "Samsung",
  "84:25:db": "Samsung",
  "8c:77:12": "Samsung",
  "94:35:0a": "Samsung",
  "a0:0b:ba": "Samsung",
  "a8:f2:74": "Samsung",
  "ac:5f:3e": "Samsung",
  "b0:c4:e7": "Samsung",
  "b4:62:93": "Samsung",
  "c4:73:1e": "Samsung",
  "c8:14:79": "Samsung",
  "c8:7e:75": "Samsung",
  "cc:07:ab": "Samsung",
  "d0:13:fd": "Samsung",
  "d4:88:90": "Samsung",
  "e8:50:8b": "Samsung",
  "ec:1f:72": "Samsung",
  "f4:09:d8": "Samsung",
  "f8:04:2e": "Samsung",
  "00:1e:75": "LG Electronics",
  "00:1f:6b": "LG Electronics",
  "00:1f:e3": "LG Electronics",
  "00:24:83": "LG Electronics",
  "00:25:e5": "LG Electronics",
  "00:e0:91": "LG Electronics",
  "10:f1:f2": "LG Electronics",
  "2c:54:cf": "LG Electronics",
  "2c:59:8a": "LG Electronics",
  "30:76:6f": "LG Electronics",
  "34:fc:ef": "LG Electronics",
  "38:8c:50": "LG Electronics",
  "48:59:29": "LG Electronics",
  "54:9b:12": "LG Electronics",
  "58:a2:b5": "LG Electronics",
  "64:99:5d": "LG Electronics",
  "70:91:8f": "LG Electronics",
  "74:a5:28": "LG Electronics",
  "94:0e:0d": "LG Electronics",
  "a0:39:f7": "LG Electronics",
  "ac:0d:1b": "LG Electronics",
  "c4:43:8f": "LG Electronics",
  "c4:9a:02": "LG Electronics",
  "d8:b1:90": "LG Electronics",
  "e8:5b:5b": "LG Electronics",
  "00:1d:0f": "TP-Link",
  "14:cc:20": "TP-Link",
  "1c:61:b4": "TP-Link",
  "50:c7:bf": "TP-Link",
  "98:da:c4": "TP-Link",
  "a0:f3:c1": "TP-Link",
  "c4:6e:1f": "TP-Link",
  "cc:32:e5": "TP-Link",
  "ec:08:6b": "TP-Link",
  "00:0b:82": "Grandstream",
  "00:25:9c": "Cisco-Linksys",
  "1c:af:f7": "D-Link",
  "30:b5:c2": "TP-Link",
  "00:24:01": "D-Link",
  "00:18:0a": "Meraki",
  "00:1b:fc": "ASUSTek",
  "00:1f:c6": "ASUSTek",
  "20:cf:30": "ASUSTek",
  "2c:fd:a1": "ASUSTek",
  "30:5a:3a": "ASUSTek",
  "40:b0:76": "ASUSTek",
  "54:04:a6": "ASUSTek",
  "58:11:22": "ASUSTek",
  "00:1f:5b": "Apple",
  "b8:27:eb": "Raspberry Pi",
  "dc:a6:32": "Raspberry Pi",
  "e4:5f:01": "Raspberry Pi",
  "00:1c:42": "Parallels",
  "08:00:69": "Silicon Graphics",
  "00:13:e8": "Intel",
  "00:1f:3a": "Intel",
  "00:21:5c": "Intel",
  "00:22:fb": "Intel",
  "00:24:d7": "Intel",
  "1c:bf:ce": "Intel",
  "44:85:00": "Intel",
  "4c:34:88": "Intel",
  "5c:e0:c5": "Intel",
  "ac:7b:a1": "Intel",
  "b0:8c:9b": "HP",
  "00:1b:78": "HP",
  "00:23:7d": "HP",
  "00:25:b3": "HP",
  "00:30:6e": "HP",
  "10:60:4b": "HP",
  "18:a9:05": "HP",
  "28:80:23": "HP",
  "2c:44:fd": "HP",
  "30:8d:99": "HP",
  "38:63:bb": "HP",
  "48:0f:cf": "HP",
  "50:65:f3": "HP",
  "70:5a:0f": "HP",
  "78:e3:b5": "HP",
  "80:c1:6e": "HP",
  "84:34:97": "HP",
  "94:18:82": "HP",
  "9c:b6:54": "HP",
  "a0:48:1c": "HP",
  "a0:b3:cc": "HP",
  "b0:5a:da": "HP",
  "d0:bf:9c": "HP",
  "d8:9d:67": "HP",
  "e0:07:1b": "HP",
  "e4:11:5b": "HP",
  "f4:39:09": "HP",
  "fc:15:b4": "HP",
  "00:1d:9c": "Roku",
  "08:05:81": "Roku",
  "20:ee:28": "Roku",
  "8c:49:62": "Roku",
  "b0:a7:37": "Roku",
  "b8:a1:75": "Roku",
  "cc:6d:a0": "Roku",
  "d8:31:34": "Roku",
};

const ROUTER_VENDORS = /tp-link|netgear|asustek|d-link|cisco|linksys|meraki|grandstream/i;
const TV_VENDORS = /samsung|lg electronics|roku|amazon|sony|sharp|vizio|panasonic|hisense|tcl/i;
const PHONE_VENDORS = /samsung|xiaomi|oppo|oneplus|huawei|google|pixel|motorola|sony mobile|apple/i;
const APPLE_VENDORS = /apple/i;
const PRINTER_VENDORS = /^hp$|hewlett|brother|canon|epson|lexmark|samsung-printer/i;
const IOT_VENDORS = /nest|ring|wyze|tuya|espressif|sonos|raspberry/i;

function normaliseMac(mac: string): string {
  return mac.trim().toLowerCase().replace(/-/g, ":");
}

function vendorFromMac(mac: string): string {
  const n = normaliseMac(mac);
  if (n.length < 8) return "Unknown";
  const prefix = n.slice(0, 8);
  return VENDOR_PREFIXES[prefix] ?? "Unknown";
}

/**
 * Detect MAC randomization. Locally-administered bit is the 2nd-lowest
 * bit of the first octet (bit 0x02). Modern phones / OSes flip this when
 * they hand out a per-SSID randomized MAC.
 */
function isRandomizedMac(mac: string): boolean {
  const n = normaliseMac(mac);
  if (n.length < 2) return false;
  const firstOctet = parseInt(n.slice(0, 2), 16);
  if (Number.isNaN(firstOctet)) return false;
  return (firstOctet & 0x02) === 0x02 && (firstOctet & 0x01) === 0x00;
}

function classify(vendor: string, hostname: string | null): string {
  const v = vendor || "";
  const h = (hostname || "").toLowerCase();
  if (ROUTER_VENDORS.test(v) || /router|gateway|ap[-_]/.test(h)) return "router";
  if (TV_VENDORS.test(v) || /(tv|webos|tizen|roku|chromecast)/i.test(h)) return "tv";
  if (PRINTER_VENDORS.test(v) || /printer|envy|laserjet|deskjet|officejet/i.test(h)) return "printer";
  if (IOT_VENDORS.test(v) || /\b(nest|ring|wyze|sonos|hue)\b/i.test(h)) return "iot";
  if (APPLE_VENDORS.test(v)) return /macbook|imac|mac-mini|macmini|mbp/i.test(h) ? "computer" : "apple";
  if (PHONE_VENDORS.test(v) && /(phone|tab|pixel|galaxy|note|pad)/i.test(h)) return "phone";
  if (/raspberry/i.test(v)) return "computer";
  return "device";
}

function makeLabel(vendor: string, hostname: string | null, mac: string): string {
  if (hostname && hostname.length > 0) return hostname;
  if (vendor && vendor !== "Unknown") return `${vendor} (${mac.slice(-8)})`;
  return `Device ${mac.slice(-8)}`;
}

interface ArpEntry { ip: string; mac: string; }

async function parseArpTable(): Promise<ArpEntry[]> {
  const isWin = osPlatform() === "win32";
  try {
    const { stdout } = await execFile(isWin ? "arp" : "arp", isWin ? ["-a"] : ["-an"], {
      timeout: 5_000,
      windowsHide: true,
      maxBuffer: 4 * 1024 * 1024
    });
    return parseArpOutput(stdout, isWin);
  } catch {
    return [];
  }
}

export function parseArpOutput(stdout: string, isWindows: boolean): ArpEntry[] {
  const out: ArpEntry[] = [];
  const macRe = /([0-9a-f]{2}[:-]){5}[0-9a-f]{2}/i;
  for (const line of stdout.split(/\r?\n/)) {
    const ipMatch = line.match(/(\d+\.\d+\.\d+\.\d+)/);
    if (!ipMatch) continue;
    const macMatch = line.match(macRe);
    if (!macMatch) continue;
    const ip = ipMatch[1];
    const mac = normaliseMac(macMatch[0]);
    if (mac === "ff:ff:ff:ff:ff:ff" || mac === "00:00:00:00:00:00") continue;
    if (ip.endsWith(".255") || ip.startsWith("224.") || ip.startsWith("239.")) continue;
    if (ip === "0.0.0.0") continue;
    void isWindows;
    out.push({ ip, mac });
  }
  return dedupeArp(out);
}

function dedupeArp(entries: ArpEntry[]): ArpEntry[] {
  const seen = new Map<string, ArpEntry>();
  for (const e of entries) {
    if (!seen.has(e.ip)) seen.set(e.ip, e);
  }
  return Array.from(seen.values());
}

interface LocalIface {
  ip: string;
  mac: string;
  cidr: number;
}

export function detectLocalInterfaces(): LocalIface[] {
  const ifaces = networkInterfaces();
  const out: LocalIface[] = [];
  for (const name of Object.keys(ifaces)) {
    const list = ifaces[name];
    if (!list) continue;
    for (const i of list) {
      if (i.family !== "IPv4") continue;
      if (i.internal) continue;
      if (i.address.startsWith("169.254")) continue; // link-local
      // Only the common consumer subnets — skip Docker bridges, Hyper-V,
      // VMware, etc. so we don't ping the wrong /24.
      if (!/^(192\.168\.|10\.|172\.(1[6-9]|2\d|3[0-1])\.)/.test(i.address)) continue;
      if (/^docker|^veth|^br-|^vEthernet/.test(name)) continue;
      const cidr = parseCidr(i.cidr ?? i.netmask);
      out.push({ ip: i.address, mac: normaliseMac(i.mac || ""), cidr });
    }
  }
  return out;
}

function parseCidr(input: string | null | undefined): number {
  if (!input) return 24;
  if (input.includes("/")) {
    const n = Number(input.split("/")[1]);
    return Number.isFinite(n) ? n : 24;
  }
  // It's a dotted netmask like "255.255.255.0".
  const parts = input.split(".").map((p) => Number(p));
  if (parts.length !== 4 || parts.some((p) => !Number.isFinite(p))) return 24;
  let bits = 0;
  for (const part of parts) {
    bits += (part.toString(2).match(/1/g) ?? []).length;
  }
  return bits;
}

function* enumerateSubnet(localIp: string, cidr: number): Generator<string> {
  if (cidr < 16 || cidr > 30) {
    // For very wide nets we'd blast thousands of hosts. Clamp at /24.
    cidr = 24;
  }
  const ipNum = ipToInt(localIp);
  const mask = cidr === 0 ? 0 : (0xffffffff << (32 - cidr)) >>> 0;
  const base = ipNum & mask;
  const broadcast = base | (~mask >>> 0);
  for (let i = base + 1; i < broadcast; i++) {
    yield intToIp(i);
  }
}

function ipToInt(ip: string): number {
  const parts = ip.split(".").map(Number);
  return (((parts[0] << 24) >>> 0) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0;
}

function intToIp(n: number): string {
  return [
    (n >>> 24) & 0xff,
    (n >>> 16) & 0xff,
    (n >>> 8) & 0xff,
    n & 0xff,
  ].join(".");
}

async function detectGateway(): Promise<{ ip: string | null; mac: string | null }> {
  const plat = osPlatform();
  try {
    if (plat === "win32") {
      const { stdout } = await execFile("ipconfig", [], { windowsHide: true, timeout: 5_000 });
      const m = stdout.match(/Default Gateway[ .]*:\s*([\d.]+)/);
      const ip = m?.[1] ?? null;
      return { ip, mac: null };
    }
    if (plat === "darwin") {
      const { stdout } = await execFile("route", ["-n", "get", "default"], { timeout: 5_000 });
      const m = stdout.match(/gateway:\s*([\d.]+)/);
      return { ip: m?.[1] ?? null, mac: null };
    }
    const { stdout } = await execFile("ip", ["route", "show", "default"], { timeout: 5_000 });
    const m = stdout.match(/default via\s+([\d.]+)/);
    return { ip: m?.[1] ?? null, mac: null };
  } catch {
    return { ip: null, mac: null };
  }
}

async function probeTcp(ip: string, timeoutMs: number): Promise<boolean> {
  // We pick TCP 80, 443, 7, 22 in that order — these are the ports that
  // most consumer devices keep open (web UI, HTTPS, echo, ssh). A single
  // SYN-ACK is enough to populate the OS ARP cache.
  const ports = [80, 443, 22, 7];
  const net = await import("node:net");
  return new Promise<boolean>((resolve) => {
    let done = false;
    let remaining = ports.length;
    const finish = (ok: boolean) => {
      if (done) return;
      done = true;
      resolve(ok);
    };
    const t = setTimeout(() => finish(false), timeoutMs);
    for (const port of ports) {
      const socket = new net.Socket();
      socket.setTimeout(timeoutMs);
      socket.once("connect", () => {
        socket.destroy();
        clearTimeout(t);
        finish(true);
      });
      const onFail = () => {
        socket.destroy();
        remaining -= 1;
        if (remaining <= 0) {
          clearTimeout(t);
          finish(false);
        }
      };
      socket.once("error", onFail);
      socket.once("timeout", onFail);
      try {
        socket.connect(port, ip);
      } catch {
        onFail();
      }
    }
  });
}

async function pingSweep(ips: string[], onTick: (done: number) => void): Promise<void> {
  // Concurrency bound — too high will make Windows TCP/IP stack queue and
  // we get worse latency, not better.
  const concurrency = 40;
  let inflight = 0;
  let cursor = 0;
  let done = 0;
  return new Promise<void>((resolve) => {
    const launch = () => {
      while (inflight < concurrency && cursor < ips.length) {
        const ip = ips[cursor++];
        inflight += 1;
        void probeTcp(ip, 400).then(() => {
          inflight -= 1;
          done += 1;
          onTick(done);
          if (cursor >= ips.length && inflight === 0) resolve();
          else launch();
        });
      }
      if (cursor >= ips.length && inflight === 0) resolve();
    };
    launch();
  });
}

async function reverseDns(ip: string): Promise<string | null> {
  try {
    const names = await dns.reverse(ip);
    return names[0] ?? null;
  } catch {
    return null;
  }
}

async function reverseDnsBatch(ips: string[]): Promise<Map<string, string | null>> {
  const out = new Map<string, string | null>();
  const concurrency = 16;
  let cursor = 0;
  const workers: Promise<void>[] = [];
  for (let w = 0; w < concurrency; w++) {
    workers.push((async () => {
      while (cursor < ips.length) {
        const ip = ips[cursor++];
        const name = await reverseDns(ip);
        out.set(ip, name);
      }
    })());
  }
  await Promise.all(workers);
  return out;
}

function computeLanFingerprint(parts: {
  gateway_ip: string;
  gateway_mac: string;
  subnet: string;
}): string {
  // Stable, deterministic, and salted so it isn't trivially equivalent
  // across users on the same router. Backend treats it as opaque; only
  // identity property is "if I'm on the same LAN I get the same string".
  const h = createHash("sha256");
  h.update("electromesh-lan-v2|");
  h.update(parts.gateway_ip);
  h.update("|");
  h.update(parts.gateway_mac);
  h.update("|");
  h.update(parts.subnet);
  return h.digest("hex").slice(0, 32);
}

export async function discover(onProgress: ProgressFn): Promise<ScanResult> {
  const t0 = Date.now();
  onProgress({ phase: "starting", pct: 4, detail: "Reading network interfaces" });

  const ifaces = detectLocalInterfaces();
  if (ifaces.length === 0) {
    // No usable LAN interface — surface a real reason instead of "Nothing
    // claimable", which the user already knows is wrong.
    throw new Error(
      "Could not find a LAN interface. Make sure you're connected to Wi-Fi or Ethernet, not a guest VLAN."
    );
  }
  const primary = ifaces[0];

  onProgress({ phase: "gateway", pct: 8, detail: "Resolving default gateway" });
  const gw = await detectGateway();
  const gatewayIp = gw.ip ?? deriveGatewayIp(primary.ip);

  // Subnet is the first three octets in /24 form. Good enough for the
  // fingerprint; sub-24 nets are rare in residential.
  const subnet = `${primary.ip.split(".").slice(0, 3).join(".")}.0/${primary.cidr || 24}`;
  onProgress({ phase: "sweep", pct: 12, detail: `Probing ${subnet}` });

  // Step 1: ping-sweep the subnet to populate the OS ARP cache.
  const ipList: string[] = [];
  for (const ip of enumerateSubnet(primary.ip, primary.cidr || 24)) {
    if (ip === primary.ip) continue;
    ipList.push(ip);
  }
  // Hard cap so a misread /16 doesn't blow up.
  const sweepList = ipList.slice(0, 254);
  await pingSweep(sweepList, (done) => {
    const span = 60; // progress from 12 → 72
    const pct = 12 + Math.round((done / sweepList.length) * span);
    onProgress({
      phase: "sweep",
      pct,
      detail: `Touched ${done}/${sweepList.length} hosts`,
    });
  });

  // Step 2: read the freshly-populated ARP table.
  onProgress({ phase: "arp", pct: 76, detail: "Reading ARP table" });
  const arpRows = await parseArpTable();

  // Step 3: reverse-DNS everything we found (the user usually wants names).
  const ipsForDns = arpRows.map((r) => r.ip);
  onProgress({ phase: "dns", pct: 84, detail: `Naming ${ipsForDns.length} hosts` });
  const names = await reverseDnsBatch(ipsForDns);

  const fingerprint = computeLanFingerprint({
    gateway_ip: gatewayIp,
    gateway_mac: arpRows.find((r) => r.ip === gatewayIp)?.mac ?? "",
    subnet,
  });

  const seen = new Set<string>();
  const items: ScannedDevice[] = [];
  const nowIso = new Date().toISOString();

  // Always include the local machine itself, marked as self so the
  // wizard can pre-uncheck it.
  items.push({
    ip: primary.ip,
    mac: primary.mac,
    hostname: hostnameFromOs(),
    vendor: vendorFromMac(primary.mac) || "This computer",
    device_class: "computer",
    label: hostnameFromOs() ?? "This computer",
    randomized_mac: false,
    lan_fingerprint: fingerprint,
    last_seen_at: nowIso,
    match_kind: "self",
    is_self: true,
  });
  seen.add(primary.ip);

  for (const row of arpRows) {
    if (seen.has(row.ip)) continue;
    const vendor = vendorFromMac(row.mac);
    const hostname = names.get(row.ip) ?? null;
    const isGateway = row.ip === gatewayIp;
    const device_class = isGateway ? "router" : classify(vendor, hostname);
    items.push({
      ip: row.ip,
      mac: row.mac,
      hostname,
      vendor,
      device_class,
      label: makeLabel(vendor, hostname, row.mac),
      randomized_mac: isRandomizedMac(row.mac),
      lan_fingerprint: fingerprint,
      last_seen_at: nowIso,
      match_kind: "ping+arp",
      is_self: false,
    });
    seen.add(row.ip);
  }

  // Sort: self first, then router, then everyone else by IP.
  items.sort((a, b) => {
    if (a.is_self !== b.is_self) return a.is_self ? -1 : 1;
    if (a.device_class === "router" && b.device_class !== "router") return -1;
    if (b.device_class === "router" && a.device_class !== "router") return 1;
    return ipToInt(a.ip) - ipToInt(b.ip);
  });

  onProgress({
    phase: "done",
    pct: 100,
    count: items.length,
    detail: `Found ${items.length} device${items.length === 1 ? "" : "s"} in ${Math.round((Date.now() - t0) / 1000)}s`,
  });

  return {
    count: items.length,
    items,
    lan_fingerprint: fingerprint,
    gateway_ip: gatewayIp,
    gateway_mac: arpRows.find((r) => r.ip === gatewayIp)?.mac ?? "",
    subnet,
    scanned_at: nowIso,
  };
}

function deriveGatewayIp(localIp: string): string {
  // Heuristic when `route` / `ip route` aren't on the box — typical home
  // routers are `.1` or `.254`. We'll guess `.1` for the fingerprint; the
  // ARP table will still find it if it's `.254` because we ping-swept the
  // whole /24.
  const head = localIp.split(".").slice(0, 3).join(".");
  return `${head}.1`;
}

function hostnameFromOs(): string | null {
  try {
    // Imported lazily so this module stays unit-testable without a full
    // electron runtime.
    const os = require("node:os") as typeof import("node:os");
    const n = os.hostname();
    return n || null;
  } catch {
    return null;
  }
}

// Re-export resolveLookup / dnsReverse so test code can monkey-patch.
export const _internals = { resolveLookup, dnsReverse };
