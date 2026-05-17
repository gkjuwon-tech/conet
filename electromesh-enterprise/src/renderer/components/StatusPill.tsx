import { cls } from "../lib/cls";

export type Tone = "active" | "ok" | "warn" | "danger" | "quiet" | "neutral";

export function StatusPill({
  tone = "neutral",
  children,
  withDot = true
}: {
  tone?: Tone;
  children: React.ReactNode;
  withDot?: boolean;
}) {
  return (
    <span className={cls("pill", tone !== "neutral" && `pill--${tone}`)}>
      {withDot && <span className="pill-dot" />}
      {children}
    </span>
  );
}
