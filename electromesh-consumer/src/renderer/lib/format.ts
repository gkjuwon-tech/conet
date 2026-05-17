import { formatDistanceToNow, parseISO } from "date-fns";

export function fmtUsd(cents: number): string {
  if (!Number.isFinite(cents)) return "$0.00";
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD"
  }).format(cents / 100);
}

export function fmtNumber(n: number, digits = 2): string {
  if (!Number.isFinite(n)) return "0";
  return new Intl.NumberFormat("en-US", {
    minimumFractionDigits: 0,
    maximumFractionDigits: digits
  }).format(n);
}

export function fmtRelative(iso: string | null | undefined): string {
  if (!iso) return "never";
  try {
    return formatDistanceToNow(parseISO(iso), { addSuffix: true });
  } catch {
    return iso;
  }
}

export function fmtPct(value: number): string {
  if (!Number.isFinite(value)) return "0%";
  return `${(value * 100).toFixed(1)}%`;
}

export function fmtBytes(mb: number): string {
  if (mb >= 1024) return `${(mb / 1024).toFixed(1)} GB`;
  return `${mb.toFixed(0)} MB`;
}

export function fmtH100(eq: number): string {
  if (eq <= 0) return "0";
  if (eq >= 1) return `${eq.toFixed(2)}× H100`;
  if (eq >= 0.001) return `${(eq * 1000).toFixed(1)} mH100`;
  return `${(eq * 1_000_000).toFixed(0)} µH100`;
}

export const DEVICE_CLASS_LABEL: Record<string, string> = {
  smart_bulb: "Smart bulb",
  smart_plug: "Smart plug",
  smart_tv: "Smart TV",
  fridge: "Refrigerator",
  washer: "Washing machine",
  dryer: "Dryer",
  microwave: "Microwave",
  router: "Router",
  nas: "NAS",
  desktop: "Desktop",
  laptop: "Laptop",
  console: "Console",
  phone: "Phone",
  tablet: "Tablet",
  camera: "Camera",
  soundbar: "Soundbar",
  stb: "Set-top box",
  gpu_rig: "GPU rig",
  other_iot: "Other IoT"
};

export const DEVICE_STATUS_PILL: Record<
  string,
  "active" | "idle" | "warn" | "danger"
> = {
  pending_attestation: "warn",
  benchmarking: "warn",
  idle: "idle",
  leased: "active",
  cooldown: "idle",
  offline: "idle",
  quarantined: "danger",
  decommissioned: "danger"
};
