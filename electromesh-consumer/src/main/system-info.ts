import os from "node:os";
import si from "systeminformation";
import crypto from "node:crypto";

export interface SystemSnapshot {
  hostname: string;
  platform: string;
  arch: string;
  os: string;
  cpuCores: number;
  cpuGhz: number;
  cpuModel: string;
  ramMb: number;
  storageGb: number;
  gpuModel: string | null;
  gpuVramMb: number;
  publicIp: string | null;
  defaultGatewayMac: string | null;
  lanFingerprint: string;
  inferredDeviceClass: string;
}

export async function readSystemSnapshot(): Promise<SystemSnapshot> {
  const [cpu, mem, gpu, fsList, net, defaultIface, osData] = await Promise.all([
    si.cpu(),
    si.mem(),
    si.graphics(),
    si.fsSize(),
    si.networkInterfaces(),
    si.networkInterfaceDefault(),
    si.osInfo()
  ]);

  const ramMb = Math.round(mem.total / 1024 / 1024);
  const storageGb = Math.round(
    fsList.reduce((acc, fs) => acc + fs.size, 0) / 1024 / 1024 / 1024
  );

  const realGpu = gpu.controllers.find(
    (c) => (c.vram ?? 0) > 256 && !/microsoft|virtual|basic/i.test(c.model ?? "")
  );

  const ifaces = Array.isArray(net) ? net : [net];
  const defaultMac =
    ifaces.find((i) => i.iface === defaultIface)?.mac ??
    ifaces.find((i) => i.default)?.mac ??
    null;

  const lanFingerprint = crypto
    .createHash("sha256")
    .update(`${os.networkInterfaces() ? "ni" : ""}|${defaultMac ?? ""}|${osData.platform}`)
    .digest("hex")
    .slice(0, 48);

  const inferredDeviceClass = inferDeviceClass({
    platform: osData.platform,
    arch: osData.arch,
    cpuCores: cpu.cores,
    ramMb,
    hasGpu: !!realGpu,
    gpuVram: realGpu?.vram ?? 0
  });

  return {
    hostname: os.hostname(),
    platform: osData.platform,
    arch: osData.arch,
    os: `${osData.distro ?? osData.platform} ${osData.release ?? ""}`.trim(),
    cpuCores: cpu.physicalCores ?? cpu.cores,
    cpuGhz: cpu.speed,
    cpuModel: `${cpu.manufacturer} ${cpu.brand}`.trim(),
    ramMb,
    storageGb,
    gpuModel: realGpu?.model ?? null,
    gpuVramMb: realGpu?.vram ?? 0,
    publicIp: null,
    defaultGatewayMac: defaultMac,
    lanFingerprint,
    inferredDeviceClass
  };
}

function inferDeviceClass(opts: {
  platform: string;
  arch: string;
  cpuCores: number;
  ramMb: number;
  hasGpu: boolean;
  gpuVram: number;
}): string {
  const { platform, cpuCores, ramMb, hasGpu, gpuVram } = opts;
  const isLaptopHint = platform === "darwin" || /macbook/i.test(os.hostname());
  if (hasGpu && gpuVram >= 12_000) return "gpu_rig";
  if (hasGpu && cpuCores >= 8 && ramMb >= 24_000) return "desktop";
  if (isLaptopHint) return "laptop";
  if (cpuCores >= 6 && ramMb >= 8_000) return "desktop";
  if (cpuCores >= 4 && ramMb >= 4_000) return "laptop";
  return "other_iot";
}

export async function readLiveTelemetry(): Promise<{
  cpu_usage_pct: number;
  gpu_usage_pct: number;
  ram_usage_pct: number;
  temperature_c: number | null;
  download_mbps: number | null;
  upload_mbps: number | null;
}> {
  const [cpu, mem, temp, gpu, netStats] = await Promise.all([
    si.currentLoad(),
    si.mem(),
    si.cpuTemperature().catch(() => ({ main: null })),
    si.graphics().catch(() => ({ controllers: [] as unknown[] })),
    si.networkStats().catch(() => [])
  ]);
  const ctrls = (gpu as { controllers: { utilizationGpu?: number }[] }).controllers ?? [];
  const gpuPct =
    ctrls.reduce((acc, c) => Math.max(acc, c.utilizationGpu ?? 0), 0) || 0;
  const stats = Array.isArray(netStats) ? netStats[0] : null;
  return {
    cpu_usage_pct: Number((cpu.currentLoad ?? 0).toFixed(2)),
    gpu_usage_pct: Number(gpuPct.toFixed(2)),
    ram_usage_pct: Number(((mem.active / mem.total) * 100).toFixed(2)),
    temperature_c: (temp as { main: number | null })?.main ?? null,
    download_mbps: stats ? Number(((stats.rx_sec ?? 0) / 125_000).toFixed(2)) : null,
    upload_mbps: stats ? Number(((stats.tx_sec ?? 0) / 125_000).toFixed(2)) : null
  };
}
