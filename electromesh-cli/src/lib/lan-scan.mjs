import { exec, spawn } from "node:child_process";
import { promisify } from "node:util";
import os from "node:os";
import crypto from "node:crypto";

const execP = promisify(exec);

const OUI_VENDOR_HINTS = {
  "70:5d:cc": { vendor: "ASUSTek", deviceClass: "router" },
  "20:3d:bd": { vendor: "Apple", deviceClass: "phone" },
  "f0:18:98": { vendor: "Apple", deviceClass: "phone" },
  "9c:35:eb": { vendor: "Apple", deviceClass: "phone" },
  "a4:c3:61": { vendor: "Apple", deviceClass: "tablet" },
  "fc:a1:83": { vendor: "Apple", deviceClass: "stb" },
  "d4:ff:1a": { vendor: "Liteon", deviceClass: "laptop" },
  "80:96:98": { vendor: "Sony", deviceClass: "smart_tv" },
  "00:1f:bb": { vendor: "Samsung", deviceClass: "smart_tv" },
  "ec:1f:72": { vendor: "Samsung", deviceClass: "smart_tv" },
  "00:1d:25": { vendor: "Samsung", deviceClass: "fridge" },
  "00:c0:ee": { vendor: "Kyocera", deviceClass: "phone" },
  "fc:f1:36": { vendor: "Samsung", deviceClass: "phone" },
  "04:d3:b0": { vendor: "Intel", deviceClass: "laptop" },
  "00:15:5d": { vendor: "Microsoft Hyper-V", deviceClass: "other_iot" },
  "b8:27:eb": { vendor: "Raspberry Pi", deviceClass: "other_iot" },
  "dc:a6:32": { vendor: "Raspberry Pi", deviceClass: "other_iot" },
  "ec:fa:bc": { vendor: "Espressif", deviceClass: "smart_bulb" },
  "84:f3:eb": { vendor: "Espressif", deviceClass: "smart_plug" },
  "cc:50:e3": { vendor: "Espressif", deviceClass: "smart_bulb" },
  "70:03:9f": { vendor: "Tuya", deviceClass: "smart_plug" },
  "50:02:91": { vendor: "Belkin", deviceClass: "router" },
  "00:09:b0": { vendor: "Onkyo", deviceClass: "soundbar" },
  "00:24:e4": { vendor: "Withings", deviceClass: "other_iot" },
  "f0:a3:b2": { vendor: "Liteon", deviceClass: "console" },
  "00:04:4b": { vendor: "NVIDIA", deviceClass: "stb" },
  "48:b0:2d": { vendor: "NVIDIA", deviceClass: "stb" },
  "b0:a7:37": { vendor: "Roku", deviceClass: "stb" },
  "d8:13:99": { vendor: "Roku", deviceClass: "stb" },
  "88:3e:ab": { vendor: "Roku", deviceClass: "stb" },
  "f0:81:73": { vendor: "Amazon", deviceClass: "stb" },
  "74:c2:46": { vendor: "Amazon", deviceClass: "stb" },
  "ec:71:db": { vendor: "Hikvision", deviceClass: "camera" },
  "98:8b:5d": { vendor: "Amcrest", deviceClass: "camera" },
  "34:12:f9": { vendor: "Wyze", deviceClass: "camera" },
  "c0:97:27": { vendor: "Ring", deviceClass: "camera" },
  "84:d6:d0": { vendor: "Amazon", deviceClass: "camera" },
  "00:1e:b3": { vendor: "Sonos", deviceClass: "soundbar" },
  "b8:e9:37": { vendor: "Sonos", deviceClass: "soundbar" },
  "9c:44:ea": { vendor: "Bose", deviceClass: "soundbar" },
  "64:1c:b0": { vendor: "Bose", deviceClass: "soundbar" }
};

function isLocallyAdministered(mac) {
  // Bit 1 of the first octet set = locally administered (random/private MAC).
  const firstByte = parseInt(mac.replace(/[^0-9a-f]/gi, "").slice(0, 2), 16);
  return (firstByte & 0x02) !== 0;
}

function isMulticast(mac) {
  const firstByte = parseInt(mac.replace(/[^0-9a-f]/gi, "").slice(0, 2), 16);
  return (firstByte & 0x01) !== 0;
}

function lookupVendor(mac) {
  const norm = mac.toLowerCase().replace(/-/g, ":");
  const prefix = norm.split(":").slice(0, 3).join(":");
  if (OUI_VENDOR_HINTS[prefix]) return OUI_VENDOR_HINTS[prefix];
  if (isLocallyAdministered(mac)) {
    // iPhones & modern Androids randomize MACs per network. Treat as phone.
    return { vendor: "Privacy-randomized", deviceClass: "phone" };
  }
  return { vendor: "Unknown", deviceClass: "other_iot" };
}

function detectLocalSubnet() {
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

async function pingSweep(subnet, onProgress) {
  const total = 254;
  let completed = 0;
  const tasks = [];
  for (let i = 1; i <= total; i++) {
    const ip = `${subnet}${i}`;
    const isWin = process.platform === "win32";
    const cmd = isWin
      ? `ping -n 1 -w 300 ${ip}`
      : `ping -c 1 -W 1 ${ip}`;
    tasks.push(
      execP(cmd, { windowsHide: true })
        .then(() => true, () => false)
        .finally(() => {
          completed += 1;
          onProgress?.(completed, total);
        })
    );
  }
  await Promise.all(tasks);
}

async function readArp() {
  const isWin = process.platform === "win32";
  const cmd = isWin ? "arp -a" : "arp -an";
  let stdout = "";
  try {
    const result = await execP(cmd, { encoding: "buffer", windowsHide: true });
    stdout = result.stdout.toString("latin1");
  } catch {
    return [];
  }
  const rows = [];
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

async function reverseDnsHostname(ip) {
  try {
    const { stdout } = await execP(`nslookup ${ip}`, {
      windowsHide: true,
      timeout: 1500
    });
    const m = stdout.match(/[Nn]ame:\s*(\S+)/);
    return m?.[1] ?? null;
  } catch {
    return null;
  }
}

export async function discoverLanDevices(opts = {}) {
  const { onLog } = opts;
  const log = onLog ?? (() => {});

  const net = detectLocalSubnet();
  if (!net) {
    log("error", "could not detect a non-loopback IPv4 subnet");
    return { ourIp: null, ourMac: null, devices: [] };
  }
  log("info", `our address: ${net.ourIp} (${net.iface})`);
  log("info", `subnet: ${net.subnet}0/24 — sweeping with ICMP echo`);

  await pingSweep(net.subnet, (done, total) => {
    if (done % 32 === 0 || done === total)
      log("progress", `ping sweep ${done}/${total}`);
  });

  log("info", "reading ARP table");
  const rows = await readArp();
  const onSubnet = rows.filter(
    (r) => r.ip.startsWith(net.subnet) && r.ip !== net.ourIp
  );

  // ONE fingerprint per LAN, derived from our adapter MAC + gateway MAC. Every
  // device on this LAN shares it so a single LanClaim covers them all.
  const gatewayRow = onSubnet.find((r) => r.ip === `${net.subnet}1`);
  const gatewayMac = gatewayRow?.mac ?? null;
  const lanFingerprint = crypto
    .createHash("sha256")
    .update(`${net.ourMac}|${gatewayMac ?? net.subnet + "0/24"}`)
    .digest("hex")
    .slice(0, 48);
  log("info", `lan fingerprint: ${lanFingerprint}`);

  log("info", `found ${onSubnet.length} hosts on ${net.subnet}0/24`);

  const enriched = [];
  for (const row of onSubnet) {
    const vendorInfo = lookupVendor(row.mac);
    const hostname = await reverseDnsHostname(row.ip);
    
    let deviceClass = vendorInfo.deviceClass;
    const lowerHost = (hostname || "").toLowerCase();
    
    if (lowerHost.includes("apple-tv") || lowerHost.includes("appletv") || lowerHost.includes("roku") || lowerHost.includes("shield") || lowerHost.includes("chromecast") || lowerHost.includes("stb") || lowerHost.includes("mibox")) {
       deviceClass = "stb";
    } else if (lowerHost.includes("cam") || lowerHost.includes("cctv") || lowerHost.includes("wyze") || lowerHost.includes("ring") || lowerHost.includes("arlo")) {
       deviceClass = "camera";
    } else if (lowerHost.includes("sonos") || lowerHost.includes("bose") || lowerHost.includes("soundbar") || lowerHost.includes("audio") || lowerHost.includes("homepod")) {
       deviceClass = "soundbar";
    } else if (lowerHost.includes("tv")) {
       deviceClass = "smart_tv";
    } else if (lowerHost.includes("phone") || lowerHost.includes("iphone") || lowerHost.includes("galaxy") || lowerHost.includes("pixel")) {
       deviceClass = "phone";
    } else if (lowerHost.includes("ipad") || lowerHost.includes("tab")) {
       deviceClass = "tablet";
    } else if (lowerHost.includes("nas") || lowerHost.includes("synology") || lowerHost.includes("qnap") || lowerHost.includes("truenas")) {
       deviceClass = "nas";
    } else if (lowerHost.includes("vacuum") || lowerHost.includes("roomba") || lowerHost.includes("roborock")) {
       deviceClass = "bot";
    }

    const card = {
      ip: row.ip,
      mac: row.mac,
      hostname,
      vendor: vendorInfo.vendor,
      device_class: deviceClass,
      label: hostname ?? `${vendorInfo.vendor} @ ${row.ip}`,
      lan_fingerprint: lanFingerprint,
      randomized_mac: isLocallyAdministered(row.mac)
    };
    enriched.push(card);
    log("device", card);
  }

  return {
    ourIp: net.ourIp,
    ourMac: net.ourMac,
    gatewayMac,
    lanFingerprint,
    devices: enriched
  };
}
