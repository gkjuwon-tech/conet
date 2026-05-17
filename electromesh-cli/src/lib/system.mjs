import os from "node:os";
import crypto from "node:crypto";
import si from "systeminformation";

export async function readSnapshot() {
  const [cpu, mem, gpu, fsList, defaultIface, ifaces, osInfo] =
    await Promise.all([
      si.cpu(),
      si.mem(),
      si.graphics().catch(() => ({ controllers: [] })),
      si.fsSize().catch(() => []),
      si.networkInterfaceDefault().catch(() => null),
      si.networkInterfaces().catch(() => []),
      si.osInfo()
    ]);

  const ramMb = Math.round(mem.total / 1024 / 1024);
  const storageGb = Math.round(
    (Array.isArray(fsList) ? fsList : []).reduce(
      (acc, fs) => acc + (fs.size || 0),
      0
    ) /
      1024 /
      1024 /
      1024
  );

  const realGpu = (gpu.controllers || []).find(
    (c) => (c.vram ?? 0) > 256 && !/microsoft|virtual|basic/i.test(c.model ?? "")
  );

  const defaultMac =
    (Array.isArray(ifaces) ? ifaces : [ifaces])
      .filter(Boolean)
      .find((i) => i.iface === defaultIface)?.mac ?? null;

  const lanFingerprint = crypto
    .createHash("sha256")
    .update(`${defaultMac ?? ""}|${osInfo.platform}|${osInfo.arch}`)
    .digest("hex")
    .slice(0, 48);

  return {
    hostname: os.hostname(),
    platform: osInfo.platform,
    arch: osInfo.arch,
    os: `${osInfo.distro || osInfo.platform} ${osInfo.release || ""}`.trim(),
    cpuCores: cpu.physicalCores ?? cpu.cores ?? os.cpus().length,
    cpuGhz: cpu.speed || (os.cpus()[0]?.speed || 0) / 1000,
    cpuModel: `${cpu.manufacturer || ""} ${cpu.brand || ""}`.trim() || (os.cpus()[0]?.model ?? ""),
    ramMb,
    storageGb,
    gpuModel: realGpu?.model ?? null,
    gpuVramMb: realGpu?.vram ?? 0,
    defaultGatewayMac: defaultMac,
    lanFingerprint,
    inferredDeviceClass: inferClass({
      platform: osInfo.platform,
      hostname: os.hostname(),
      cpuCores: cpu.cores ?? 0,
      ramMb,
      hasGpu: !!realGpu,
      gpuVramMb: realGpu?.vram ?? 0
    })
  };
}

function inferClass({ platform, hostname, cpuCores, ramMb, hasGpu, gpuVramMb }) {
  if (hasGpu && gpuVramMb >= 12_000) return "gpu_rig";
  if (hasGpu && cpuCores >= 8 && ramMb >= 24_000) return "desktop";
  if (platform === "darwin" || /macbook/i.test(hostname)) return "laptop";
  if (cpuCores >= 6 && ramMb >= 8_000) return "desktop";
  if (cpuCores >= 4 && ramMb >= 4_000) return "laptop";
  return "other_iot";
}

export async function readLiveTelemetry() {
  const [cpu, mem, temp, gpu, netStats] = await Promise.all([
    si.currentLoad(),
    si.mem(),
    si.cpuTemperature().catch(() => ({ main: null })),
    si.graphics().catch(() => ({ controllers: [] })),
    si.networkStats().catch(() => [])
  ]);
  const gpuPct = (gpu.controllers || []).reduce(
    (acc, c) => Math.max(acc, c.utilizationGpu ?? 0),
    0
  );
  const stats = Array.isArray(netStats) ? netStats[0] : null;
  return {
    cpu_usage_pct: Number((cpu.currentLoad ?? 0).toFixed(2)),
    gpu_usage_pct: Number(gpuPct.toFixed(2)),
    ram_usage_pct: Number(((mem.active / mem.total) * 100).toFixed(2)),
    temperature_c: temp?.main ?? null,
    download_mbps: stats ? Number(((stats.rx_sec ?? 0) / 125_000).toFixed(2)) : null,
    upload_mbps: stats ? Number(((stats.tx_sec ?? 0) / 125_000).toFixed(2)) : null
  };
}
