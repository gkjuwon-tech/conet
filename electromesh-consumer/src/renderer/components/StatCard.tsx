import type { ReactNode } from "react";

interface Props {
  label: string;
  value: ReactNode;
  hint?: ReactNode;
  accent?: "default" | "brand" | "warn";
}

export function StatCard({ label, value, hint, accent = "default" }: Props) {
  const accentClass = accent === "brand"
    ? "border-brand-500/30 bg-brand-500/5"
    : accent === "warn"
      ? "border-warn-500/30 bg-warn-500/5"
      : "border-white/5";
  return (
    <div className={`em-card ${accentClass} p-5`}>
      <div className="text-[11px] uppercase tracking-wider text-ink-secondary">
        {label}
      </div>
      <div className="mt-2 text-2xl font-semibold tracking-tight">{value}</div>
      {hint && <div className="mt-1 text-xs text-ink-secondary">{hint}</div>}
    </div>
  );
}
