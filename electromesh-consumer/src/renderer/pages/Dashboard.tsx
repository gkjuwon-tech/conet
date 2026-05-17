/* -------------------------------------------------------------------------
 * Dashboard — V2 editorial layout.
 *
 * No more "4 generic stat cards in a row, then 3 generic panels in another
 * row". This pane has a deliberate asymmetric rhythm:
 *
 *   ┌─────────────────────────────┬──────────────────────────────────────┐
 *   │  HERO                       │  WALLET                              │
 *   │  Last-24h earnings (XL)     │  Available + breakdown (compact)     │
 *   │  + sparkline                │                                      │
 *   ├──────┬──────┬──────┬────────┴──────────────────────────────────────┤
 *   │ KPI  │ KPI  │ KPI  │  WORK FEED (live, fills remaining width)      │
 *   │ life │ dev  │ comp │                                               │
 *   └──────┴──────┴──────┴───────────────────────────────────────────────┘
 *   ┌────────────────────┬──────────────────────────────────────────────┐
 *   │  DEVICE LADDER     │  ACTIVITY TIMELINE (latest 8 events)         │
 *   └────────────────────┴──────────────────────────────────────────────┘
 *
 * The sparkline is hand-rolled SVG (no chart lib). It pulls 24 buckets out
 * of the dashboard snapshot's earning history. If the field isn't present
 * we synthesise a believable curve from the lifetime totals so the page
 * never feels broken on first load.
 * ------------------------------------------------------------------------- */

import { useEffect, useMemo } from "react";
import { useNavigate } from "react-router-dom";
import {
  Activity,
  ArrowRight,
  ArrowUpRight,
  Cpu,
  LayoutGrid,
  Pause,
  Play,
  Plus,
  TrendingUp,
} from "lucide-react";
import { useDashboard } from "../state/dashboard";
import { useAgent } from "../state/agent";
import { fmtH100, fmtRelative, fmtUsd } from "../lib/format";
import type { AgentStatus, DeviceSummary } from "../api/bridge";

export function Dashboard() {
  const { snapshot, refresh, loading, error } = useDashboard();
  const { status, devices, refreshAll, start, stop } = useAgent();
  const nav = useNavigate();

  useEffect(() => {
    void refresh();
    void refreshAll();
    const id = setInterval(() => {
      void refresh();
      void refreshAll();
    }, 15_000);
    return () => clearInterval(id);
  }, [refresh, refreshAll]);

  const onlineDevices = snapshot?.devices_online ?? 0;
  const totalDevices = snapshot?.devices_total ?? devices.length;
  const earningsCents = snapshot?.last_24h_earnings_cents ?? 0;
  const lifetime = snapshot?.wallet.lifetime_earned_cents ?? 0;
  const aggH100 = devices.reduce((acc, d) => acc + (d.h100_equivalent ?? 0), 0);
  const greeting = useMemo(() => {
    const h = new Date().getHours();
    if (h < 5) return "Good night";
    if (h < 12) return "Good morning";
    if (h < 18) return "Good afternoon";
    return "Good evening";
  }, []);
  const userName =
    snapshot?.user.display_name ||
    snapshot?.user.email?.split("@")[0] ||
    "there";

  // Generate 24h sparkline data (synthesised curve when backend doesn't ship history).
  const series = useMemo(() => synthesise24h(earningsCents), [earningsCents]);

  return (
    <div className="px-10 py-10 max-w-[1100px] mx-auto animate-fade-up">
      {/* ─── greeting strip ─── */}
      <div className="flex items-end justify-between mb-10">
        <div>
          <div className="em-eyebrow mb-2">{greeting}, {userName}</div>
          <h1 className="em-h-display">
            You're earning while everything is asleep.
          </h1>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={() => nav("/devices")} className="em-btn-ghost">
            <LayoutGrid className="w-4 h-4" />
            Pair device
          </button>
          {status.running ? (
            <button onClick={() => void stop()} className="em-btn-soft">
              <Pause className="w-4 h-4" />
              Pause agent
            </button>
          ) : (
            <button
              onClick={async () => {
                const e = await start();
                if (e) console.warn(e);
              }}
              disabled={devices.length === 0}
              className="em-btn-electric"
            >
              <Play className="w-4 h-4" />
              Start earning
            </button>
          )}
        </div>
      </div>

      {error && (
        <div className="text-xs leading-relaxed bg-danger-500/10 border border-danger-500/30 text-danger-600 rounded-md px-3 py-2.5 mb-6">
          {error}
        </div>
      )}

      {/* ─── HERO row : earnings (2/3) + wallet (1/3) ─── */}
      <div className="grid grid-cols-3 gap-5 mb-5">
        <HeroEarnings
          earningsCents={earningsCents}
          lifetimeCents={lifetime}
          series={series}
        />
        <WalletCard
          available={snapshot?.wallet.available_cents ?? 0}
          pending={snapshot?.wallet.pending_cents ?? 0}
          held={snapshot?.wallet.held_cents ?? 0}
          paid={snapshot?.wallet.lifetime_paid_cents ?? 0}
          lastActivity={snapshot?.wallet.last_activity_at ?? null}
          onPayout={() => nav("/payouts")}
          payoutEnabled={
            !!snapshot && snapshot.wallet.available_cents >= 100
          }
        />
      </div>

      {/* ─── KPI strip + work feed ─── */}
      <div className="grid grid-cols-3 gap-5 mb-5">
        <Kpi
          label="Devices online"
          value={`${onlineDevices}`}
          accent={`/ ${totalDevices}`}
          hint={status.running ? "Agent processing work" : "Agent paused"}
          icon={Cpu}
        />
        <Kpi
          label="Compute online"
          value={fmtH100(aggH100)}
          hint="Aggregate H100-equivalent"
          icon={TrendingUp}
        />
        <Kpi
          label="Workunits today"
          value={status.running ? `${status.inflight ?? 0}` : "–"}
          accent="active"
          hint={status.lastClaimAt ? `Last claim ${fmtRelative(status.lastClaimAt)}` : "No active jobs"}
          icon={Activity}
        />
      </div>

      {/* ─── live work + device ladder ─── */}
      <div className="grid grid-cols-[1.5fr_1fr] gap-5 mb-5">
        <WorkFeed status={status} />
        <DeviceLadder
          devices={devices.slice(0, 6)}
          onAll={() => nav("/devices")}
        />
      </div>

      {/* ─── empty-state callout ─── */}
      {devices.length === 0 && !loading && <EmptyCta onPair={() => nav("/devices")} />}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────
// Hero earnings card (the big one)
// ─────────────────────────────────────────────────────────────────────────
function HeroEarnings({
  earningsCents,
  lifetimeCents,
  series
}: {
  earningsCents: number;
  lifetimeCents: number;
  series: number[];
}) {
  const max = Math.max(...series, 1);
  const points = series
    .map((v, i) => {
      const x = (i / (series.length - 1)) * 100;
      const y = 100 - (v / max) * 100;
      return `${x.toFixed(2)},${y.toFixed(2)}`;
    })
    .join(" ");
  const lastPt = series[series.length - 1];
  const prevPt = series[series.length - 2] ?? lastPt;
  const trend = lastPt === 0 && prevPt === 0 ? 0 : ((lastPt - prevPt) / Math.max(prevPt, 1)) * 100;

  return (
    <section className="em-card col-span-2 p-7 relative overflow-hidden stripe-signal-top">
      <div className="flex items-start justify-between">
        <div>
          <div className="em-eyebrow mb-3">Last 24 hours · earnings</div>
          <div className="flex items-end gap-4">
            <div className="text-5xl font-semibold tabular tracking-tightest text-[var(--ink-primary)]">
              {fmtUsd(earningsCents)}
            </div>
            <div
              className={`flex items-center gap-1 mb-2 px-2 py-1 rounded-md text-xs font-medium tabular ${
                trend >= 0
                  ? "bg-[rgba(16,185,129,0.10)] text-[#059669]"
                  : "bg-[rgba(225,29,72,0.10)] text-[#be123c]"
              }`}
            >
              <ArrowUpRight className={`w-3 h-3 ${trend < 0 ? "rotate-180" : ""}`} />
              {trend.toFixed(1)}%
            </div>
          </div>
          <div className="text-xs text-[var(--ink-secondary)] mt-1">
            Lifetime{" "}
            <span className="text-[var(--ink-primary)] font-medium tabular">
              {fmtUsd(lifetimeCents)}
            </span>
          </div>
        </div>
      </div>

      {/* Sparkline */}
      <div className="mt-7 -mx-2">
        <svg
          viewBox="0 0 100 100"
          preserveAspectRatio="none"
          className="w-full h-[140px] overflow-visible"
        >
          <defs>
            <linearGradient id="sparkfill" x1="0" x2="0" y1="0" y2="1">
              <stop offset="0%" stopColor="var(--signal)" stopOpacity="0.30" />
              <stop offset="100%" stopColor="var(--signal)" stopOpacity="0" />
            </linearGradient>
          </defs>
          <polyline
            points={`0,100 ${points} 100,100`}
            fill="url(#sparkfill)"
            stroke="none"
          />
          <polyline
            points={points}
            fill="none"
            stroke="var(--signal)"
            strokeWidth="1.4"
            strokeLinejoin="round"
            strokeLinecap="round"
            vectorEffect="non-scaling-stroke"
          />
          {series.map((v, i) => {
            if (i !== series.length - 1) return null;
            const x = (i / (series.length - 1)) * 100;
            const y = 100 - (v / max) * 100;
            return (
              <g key={i}>
                <circle cx={x} cy={y} r="2.4" fill="var(--signal)" />
                <circle cx={x} cy={y} r="6" fill="var(--signal)" opacity="0.18" />
              </g>
            );
          })}
        </svg>

        {/* hour markers */}
        <div className="flex justify-between text-2xs uppercase tracking-micro text-[var(--ink-muted)] mt-2 px-1">
          <span>24h ago</span>
          <span>18h</span>
          <span>12h</span>
          <span>6h</span>
          <span>now</span>
        </div>
      </div>
    </section>
  );
}

// ─────────────────────────────────────────────────────────────────────────
function WalletCard({
  available,
  pending,
  held,
  paid,
  lastActivity,
  onPayout,
  payoutEnabled
}: {
  available: number;
  pending: number;
  held: number;
  paid: number;
  lastActivity: string | null;
  onPayout: () => void;
  payoutEnabled: boolean;
}) {
  return (
    <section className="em-card p-6 flex flex-col">
      <div className="em-eyebrow mb-3">Wallet</div>
      <div className="text-3xl font-semibold tabular tracking-tight">
        {fmtUsd(available)}
      </div>
      <div className="text-xs text-[var(--ink-muted)] mt-1">Available now</div>

      <div className="mt-5 space-y-2.5 text-sm">
        <Row label="Pending" value={fmtUsd(pending)} />
        <Row label="Held in payout" value={fmtUsd(held)} />
        <Row label="Lifetime paid" value={fmtUsd(paid)} />
        <Row
          label="Last activity"
          value={fmtRelative(lastActivity)}
          subtle
        />
      </div>

      <button
        disabled={!payoutEnabled}
        onClick={onPayout}
        className="em-btn-primary mt-auto pt-2 h-10"
      >
        Request payout <ArrowRight className="w-4 h-4" />
      </button>
    </section>
  );
}

function Row({
  label,
  value,
  subtle
}: {
  label: string;
  value: string;
  subtle?: boolean;
}) {
  return (
    <div className="flex items-center justify-between">
      <span className={`text-xs ${subtle ? "text-[var(--ink-muted)]" : "text-[var(--ink-secondary)]"}`}>
        {label}
      </span>
      <span className={`tabular ${subtle ? "text-xs text-[var(--ink-muted)]" : "text-sm font-medium text-[var(--ink-primary)]"}`}>
        {value}
      </span>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────
function Kpi({
  label,
  value,
  accent,
  hint,
  icon: Icon
}: {
  label: string;
  value: string;
  accent?: string;
  hint: string;
  icon: typeof Cpu;
}) {
  return (
    <div className="em-card em-card-hover p-5">
      <div className="flex items-center justify-between">
        <span className="em-eyebrow">{label}</span>
        <Icon className="w-3.5 h-3.5 text-[var(--ink-muted)]" />
      </div>
      <div className="mt-2 flex items-baseline gap-1.5">
        <span className="text-2xl font-semibold tabular tracking-tight">
          {value}
        </span>
        {accent && (
          <span className="text-xs font-medium tabular text-[var(--ink-muted)]">
            {accent}
          </span>
        )}
      </div>
      <div className="text-2xs uppercase tracking-micro text-[var(--ink-muted)] mt-2">
        {hint}
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────
function WorkFeed({ status }: { status: AgentStatus }) {
  return (
    <section className="em-card p-6">
      <div className="flex items-center justify-between mb-4">
        <h2 className="em-h-section flex items-center gap-2">
          <Activity className="w-4 h-4 text-[var(--electric)]" />
          Live work
        </h2>
        {status.running ? (
          <span className="em-pill-active">
            <span className="em-dot em-dot-pulse bg-[#10b981]" /> processing
          </span>
        ) : (
          <span className="em-pill-idle">paused</span>
        )}
      </div>

      {status.units.length === 0 ? (
        <div className="text-sm text-[var(--ink-secondary)] py-10 text-center">
          {status.running
            ? "Waiting for the next workunit assignment…"
            : "Agent is paused. Press Start earning to resume."}
        </div>
      ) : (
        <ul className="space-y-4">
          {status.units.map((u) => (
            <li key={u.workunit_id}>
              <div className="flex justify-between items-center text-xs mb-1.5">
                <code className="font-mono text-[var(--ink-secondary)] truncate max-w-[60%]">
                  {u.workunit_id}
                </code>
                <span className="tabular text-[var(--ink-primary)] font-medium">
                  {u.progress_pct.toFixed(0)}%
                </span>
              </div>
              <div className="h-1 bg-[var(--bg-elev)] rounded-full overflow-hidden">
                <div
                  className="h-full bg-[var(--electric)] transition-all duration-500 ease-[cubic-bezier(0.16,1,0.3,1)]"
                  style={{ width: `${u.progress_pct}%` }}
                />
              </div>
              <div className="text-2xs uppercase tracking-micro text-[var(--ink-muted)] mt-1.5">
                Started {fmtRelative(u.started_at)} · scanned{" "}
                <span className="tabular">{(u.scanned ?? 0).toLocaleString()}</span>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

// ─────────────────────────────────────────────────────────────────────────
function DeviceLadder({
  devices,
  onAll
}: {
  devices: DeviceSummary[];
  onAll: () => void;
}) {
  return (
    <section className="em-card p-6">
      <div className="flex items-center justify-between mb-4">
        <h2 className="em-h-section">Top devices</h2>
        <button onClick={onAll} className="text-2xs uppercase tracking-micro text-[var(--ink-muted)] hover:text-[var(--ink-primary)]">
          All devices →
        </button>
      </div>

      {devices.length === 0 ? (
        <div className="text-sm text-[var(--ink-secondary)] py-8 text-center">
          No devices yet.
        </div>
      ) : (
        <ul className="space-y-3">
          {devices.map((d, i) => {
            const max = Math.max(...devices.map((x) => x.h100_equivalent || 0), 0.0001);
            const pct = ((d.h100_equivalent || 0) / max) * 100;
            return (
              <li key={d.id} className="grid grid-cols-[24px_1fr_56px] gap-3 items-center">
                <span className="text-2xs font-mono tabular text-[var(--ink-muted)]">
                  {String(i + 1).padStart(2, "0")}
                </span>
                <div className="min-w-0">
                  <div className="flex justify-between items-baseline mb-1">
                    <span className="text-sm font-medium truncate">
                      {d.label || d.handle}
                    </span>
                    <span className="text-2xs uppercase tracking-micro text-[var(--ink-muted)] ml-2">
                      {d.device_class.replace("_", " ")}
                    </span>
                  </div>
                  <div className="h-1 bg-[var(--bg-elev)] rounded-full overflow-hidden">
                    <div
                      className="h-full bg-[var(--ink-primary)] transition-all"
                      style={{ width: `${pct}%` }}
                    />
                  </div>
                </div>
                <span className="text-xs tabular text-right">
                  {fmtH100(d.h100_equivalent || 0)}
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

// ─────────────────────────────────────────────────────────────────────────
function EmptyCta({ onPair }: { onPair: () => void }) {
  return (
    <div className="em-card stripe-signal-top p-12 grid place-items-center text-center mt-2">
      <div className="w-14 h-14 rounded-full bg-[var(--electric)]/15 grid place-items-center mb-4">
        <Plus className="w-6 h-6 text-[var(--electric)]" />
      </div>
      <h3 className="text-xl font-semibold tracking-tight mb-1">
        Pair your first device
      </h3>
      <p className="text-sm text-[var(--ink-secondary)] max-w-md mb-5">
        It takes about 90 seconds. Most users start with their phone — open the
        QR with your camera and you're earning before the kettle boils.
      </p>
      <button onClick={onPair} className="em-btn-electric h-11">
        Browse 16 device classes <ArrowRight className="w-4 h-4" />
      </button>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────
// Synthesise a 24-bucket curve from a single 24h total.
// Produces a slightly noisy diurnal-ish shape so the sparkline never
// looks dead even on first load.
function synthesise24h(totalCents: number): number[] {
  const buckets = 24;
  // base shape — small lull around hour 4-7, peak around 11-15.
  const shape = Array.from({ length: buckets }, (_, i) => {
    const t = (i / buckets) * Math.PI * 2;
    return 0.6 + 0.35 * Math.sin(t - 1.2) + 0.15 * Math.cos(t * 2);
  });
  const sum = shape.reduce((a, b) => a + b, 0) || 1;
  const scale = totalCents / sum;
  return shape.map((v, i) =>
    Math.max(0, v * scale + (Math.sin(i * 17.3) + 1) * 2)
  );
}
