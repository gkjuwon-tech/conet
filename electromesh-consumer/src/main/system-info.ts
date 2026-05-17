import { hostname, type, release, arch } from "node:os";
import si from "systeminformation";

export interface SystemSnapshot {
  hostname: string;
  os: string;
  cpuModel: string;
  cpuPhysical: number;
  cpuLogical: number;
  ramTotalMb: number;
  ramAvailableMb: number;
  cpuPct: number;
  ramPct: number;
  tempC: number | null;
  battery: { hasBattery: boolean; percent: number | null; charging: boolean };
}

let cachedStatic: Pick<SystemSnapshot, "hostname" | "os" | "cpuModel" | "cpuPhysical" | "cpuLogical"> | null = null;

async function getStatic() {
  if (cachedStatic) return cachedStatic;
  const cpu = await si.cpu();
  cachedStatic = {
    hostname: hostname(),
    os: `${type()} ${release()} (${arch()})`,
    cpuModel: `${cpu.manufacturer} ${cpu.brand}`.trim(),
    cpuPhysical: cpu.physicalCores ?? cpu.cores ?? 1,
    cpuLogical: cpu.cores ?? 1
  };
  return cachedStatic;
}

export async function snapshot(): Promise<SystemSnapshot> {
  const stat = await getStatic();
  const [load, mem, temp, batt] = await Promise.all([
    si.currentLoad().catch(() => null),
    si.mem().catch(() => null),
    si.cpuTemperature().catch(() => null),
    si.battery().catch(() => null)
  ]);
  const cpuPct = load && typeof load.currentLoad === "number" ? Math.round(load.currentLoad * 10) / 10 : 0;
  const ramTotalMb = mem ? Math.round(mem.total / 1024 / 1024) : 0;
  const ramAvailableMb = mem ? Math.round(mem.available / 1024 / 1024) : 0;
  const ramPct = mem && mem.total
    ? Math.round(((mem.total - mem.available) / mem.total) * 1000) / 10
    : 0;
  const tempC = temp && typeof temp.main === "number" && temp.main > 0 ? Math.round(temp.main * 10) / 10 : null;
  const battery = {
    hasBattery: Boolean(batt?.hasBattery),
    percent: batt && typeof batt.percent === "number" ? batt.percent : null,
    charging: Boolean(batt?.isCharging)
  };
  return {
    ...stat,
    cpuPct,
    ramPct,
    ramTotalMb,
    ramAvailableMb,
    tempC,
    battery
  };
}
