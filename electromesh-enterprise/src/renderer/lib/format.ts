import { formatDistanceToNow, parseISO } from "date-fns";

export function fmtUsd(cents: number): string {
  if (!Number.isFinite(cents)) return "$0.00";
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD"
  }).format(cents / 100);
}

export function fmtRate(usdHour: number): string {
  return `${fmtUsd(usdHour * 100)} / hr`;
}

export function fmtNumber(n: number, digits = 2): string {
  if (!Number.isFinite(n)) return "0";
  return new Intl.NumberFormat("en-US", {
    minimumFractionDigits: 0,
    maximumFractionDigits: digits
  }).format(n);
}

export function fmtRelative(iso: string | null | undefined): string {
  if (!iso) return "—";
  try {
    return formatDistanceToNow(parseISO(iso), { addSuffix: true });
  } catch {
    return iso;
  }
}

export function fmtH100(eq: number): string {
  if (eq <= 0) return "0";
  if (eq >= 1) return `${eq.toFixed(2)}× H100`;
  if (eq >= 0.001) return `${(eq * 1000).toFixed(1)} mH100`;
  return `${(eq * 1_000_000).toFixed(0)} µH100`;
}

export function fmtPct(value: number): string {
  if (!Number.isFinite(value)) return "0%";
  return `${(value * 100).toFixed(1)}%`;
}

export function fmtMb(mb: number): string {
  if (mb >= 1024 * 1024) return `${(mb / 1024 / 1024).toFixed(1)} TB`;
  if (mb >= 1024) return `${(mb / 1024).toFixed(1)} GB`;
  return `${mb.toFixed(0)} MB`;
}

export const JOB_STATUS_PILL: Record<
  string,
  "active" | "idle" | "warn" | "danger"
> = {
  draft: "idle",
  queued: "warn",
  leasing: "warn",
  running: "active",
  succeeded: "active",
  failed: "danger",
  cancelled: "idle",
  timed_out: "danger",
  rejected: "danger"
};

export const JOB_KINDS = [
  { id: "hashcrack.range", label: "Hash crack — keyspace range" },
  { id: "hashcrack.dict", label: "Hash crack — dictionary" },
  { id: "fhe.share", label: "FHE share computation" },
  { id: "mpc.share", label: "MPC share computation" },
  { id: "ml.embed.public", label: "ML embedding (public model)" },
  { id: "render.tile", label: "Render tile" }
];
