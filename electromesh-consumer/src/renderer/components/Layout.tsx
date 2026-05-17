/* -------------------------------------------------------------------------
 * Editorial layout — narrow left rail + a context strip on top of the
 * content column.
 *
 *   [ rail ]  ┌──────────────────────────────────────────────────────────┐
 *   |  ⏷ |    │  ── 02 / DEVICES         agent ● active     ⌘K           │  ← context strip
 *   |  ⌂ |    ├──────────────────────────────────────────────────────────┤
 *   |  ⌹ |    │                                                          │
 *   |  ⌸ |    │      content (max-width 1080)                            │
 *   |  ⚙ |    │                                                          │
 *
 * The rail is icon-only by default (56 px); hovering reveals labels via
 * tooltip. There's no top page-wide header — every page now owns its own
 * vertical rhythm.
 * ------------------------------------------------------------------------- */

import { useEffect, useMemo } from "react";
import {
  NavLink,
  Outlet,
  useLocation,
  useNavigate,
} from "react-router-dom";
import {
  Activity,
  Banknote,
  Cpu,
  Home,
  LogOut,
  Settings,
  Wallet as WalletIcon,
} from "lucide-react";
import { useAuth } from "../state/auth";
import { useAgent } from "../state/agent";
import type { AgentStatus } from "../api/bridge";
import { ElectroMark } from "./Brand";

interface NavItem {
  to: string;
  label: string;
  numeral: string;
  icon: typeof Home;
  end?: boolean;
}

const NAV: NavItem[] = [
  { to: "/",         label: "Overview", numeral: "01", icon: Home, end: true },
  { to: "/devices",  label: "Devices",  numeral: "02", icon: Cpu },
  { to: "/earnings", label: "Earnings", numeral: "03", icon: WalletIcon },
  { to: "/payouts",  label: "Payouts",  numeral: "04", icon: Banknote },
  { to: "/settings", label: "Settings", numeral: "05", icon: Settings },
];

export function Layout() {
  const { user, logout } = useAuth();
  const { status, refreshAll } = useAgent();
  const nav = useNavigate();

  useEffect(() => {
    void refreshAll();
    const id = setInterval(() => void refreshAll(), 12_000);
    return () => clearInterval(id);
  }, [refreshAll]);

  const loc = useLocation();
  const current = useMemo(
    () =>
      NAV.find((n) =>
        n.end ? loc.pathname === n.to : loc.pathname.startsWith(n.to) && n.to !== "/"
      ) ?? NAV[0],
    [loc.pathname]
  );

  return (
    <div className="flex h-full bg-[var(--bg-page)] relative">
      {/* Editorial dot-grid texture — same vibe as the marketing pages, so
          the in-app experience doesn't feel like a downgrade after sign-in. */}
      <div
        className="pointer-events-none absolute inset-0 opacity-[0.45]"
        style={{
          backgroundImage:
            "radial-gradient(rgba(28,25,23,0.07) 1px, transparent 1.4px)",
          backgroundSize: "22px 22px",
          maskImage:
            "radial-gradient(circle at 30% 30%, black, transparent 70%)",
          WebkitMaskImage:
            "radial-gradient(circle at 30% 30%, black, transparent 70%)",
        }}
      />

      {/* ─────────── Icon rail ─────────── */}
      <aside className="shrink-0 w-[56px] h-full flex flex-col items-center bg-[var(--bg-surface)] border-r border-[var(--hairline)] relative z-10">
        <button
          onClick={() => nav("/")}
          className="h-16 w-full grid place-items-center border-b border-[var(--hairline)]"
          title="conet"
        >
          <ElectroMark className="w-6 h-6 text-[var(--ink-primary)]" />
        </button>

        <nav className="flex-1 flex flex-col items-center pt-3 gap-1">
          {NAV.map((item) => (
            <RailIconLink key={item.to} item={item} />
          ))}
        </nav>

        <div className="pb-3 flex flex-col items-center gap-2">
          <Avatar email={user?.email ?? ""} />
          <button
            onClick={async () => {
              await logout();
              nav("/login");
            }}
            className="em-icon-btn"
            title={`Sign out — ${user?.email ?? ""}`}
          >
            <LogOut className="w-4 h-4" />
          </button>
        </div>
      </aside>

      {/* ─────────── Main column ─────────── */}
       <main className="flex-1 overflow-auto flex flex-col">
         <ContextStrip current={current} status={status} userEmail={user?.email ?? null} />
         <div className="flex-1 px-10 py-10 max-w-[1100px] mx-auto">
           <Outlet />
         </div>
       </main>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────
function RailIconLink({ item }: { item: NavItem }) {
  return (
    <NavLink
      to={item.to}
      end={item.end}
      title={`${item.numeral} · ${item.label}`}
      className={({ isActive }) =>
        `relative w-10 h-10 grid place-items-center rounded-md transition-colors group ${
          isActive
            ? "text-[var(--ink-primary)]"
            : "text-[var(--ink-secondary)] hover:text-[var(--ink-primary)] hover:bg-[var(--bg-hover)]"
        }`
      }
    >
      {({ isActive }) => (
        <>
          {isActive && (
            <span className="absolute left-[-8px] top-2 bottom-2 w-[2px] bg-[var(--electric)] rounded-r" />
          )}
          <item.icon className="w-4 h-4" />
          {/* Hover tooltip — slides out from the rail. */}
          <span className="absolute left-12 top-1/2 -translate-y-1/2 whitespace-nowrap pointer-events-none
                           opacity-0 group-hover:opacity-100 transition-opacity duration-150
                           bg-[var(--ink-primary)] text-[var(--bg-surface)] text-xs px-2 py-1 rounded-md shadow-md z-30">
            <span className="text-[var(--electric)] font-mono mr-1.5">{item.numeral}</span>
            {item.label}
          </span>
        </>
      )}
    </NavLink>
  );
}

// ─────────────────────────────────────────────────────────────────────────
function ContextStrip({
  current,
  status,
  userEmail,
}: {
  current: NavItem;
  status: AgentStatus;
  userEmail: string | null;
}) {
  return (
    <div className="h-14 flex items-center justify-between px-10 border-b border-[var(--hairline)] bg-[var(--bg-page)]/80 backdrop-blur sticky top-0 z-30">
      <div className="flex items-baseline gap-3">
        <span className="text-2xs font-mono uppercase tracking-micro text-[var(--ink-muted)]">
          — {current.numeral} /
        </span>
        <span className="text-sm font-medium tracking-tight text-[var(--ink-primary)]">
          {current.label}
        </span>
      </div>
      <div className="flex items-center gap-5">
        <AgentStatus running={status.running} inflight={status.inflight} />
        <div className="hidden md:block text-2xs uppercase tracking-micro text-[var(--ink-muted)]">
          {userEmail}
        </div>
      </div>
    </div>
  );
}

function AgentStatus({ running, inflight }: { running: boolean; inflight: number }) {
  return (
    <div className="flex items-center gap-2 text-2xs uppercase tracking-micro">
      <span
        className={`em-dot ${
          running ? "em-dot-pulse bg-[var(--ok-500,#10b981)]" : "bg-[var(--ink-muted)]"
        }`}
      />
      <span className="text-[var(--ink-secondary)]">
        Agent {running ? "active" : "paused"}
      </span>
      {running && inflight > 0 && (
        <>
          <span className="text-[var(--ink-muted)]">·</span>
          <span className="text-[var(--electric)] flex items-center gap-1">
            <Activity className="w-3 h-3" />
            <span className="tabular">{inflight}</span> jobs
          </span>
        </>
      )}
    </div>
  );
}

function Avatar({ email }: { email: string }) {
  const initial = (email[0] ?? "?").toUpperCase();
  const hue = ((email.charCodeAt(0) * 53 + email.charCodeAt(1) * 71) % 360) || 30;
  return (
    <div
      className="w-7 h-7 rounded-md grid place-items-center text-[11px] font-semibold shrink-0 text-[var(--ink-primary)]"
      style={{
        background: `linear-gradient(135deg, hsl(${hue} 70% 80%), hsl(${(hue + 30) % 360} 80% 70%))`,
      }}
    >
      {initial}
    </div>
  );
}
