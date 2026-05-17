/* -------------------------------------------------------------------------
 * Enterprise sidebar layout — same Electric-Editorial language as the
 * consumer app's IDE-style sidebar, but the footer carries the cart pill
 * and the tenant block instead of an agent-status indicator.
 * ------------------------------------------------------------------------- */

import { useState } from "react";
import { NavLink, Outlet, useNavigate } from "react-router-dom";
import {
  Briefcase,
  KeyRound,
  LayoutDashboard,
  LogOut,
  PanelLeftClose,
  PanelLeftOpen,
  Settings,
  ShoppingBag,
  ShoppingCart,
} from "lucide-react";
import { useAuth } from "../state/auth";
import { useCart } from "../state/cart";
import { fmtUsd } from "../lib/format";

const NAV: { to: string; label: string; icon: typeof LayoutDashboard; end?: boolean }[] = [
  { to: "/",            label: "Overview",    icon: LayoutDashboard, end: true },
  { to: "/marketplace", label: "Marketplace", icon: ShoppingBag },
  { to: "/jobs",        label: "Jobs",        icon: Briefcase },
  { to: "/api-keys",    label: "API keys",    icon: KeyRound },
  { to: "/settings",    label: "Settings",    icon: Settings },
];

export function Layout() {
  const { enterprise, disconnect } = useAuth();
  const cart = useCart((s) => s.lines);
  const totals = useCart((s) => s.totals());
  const nav = useNavigate();
  const [collapsed, setCollapsed] = useState(
    () => localStorage.getItem("em-ent-sidebar-collapsed") === "1"
  );

  function toggle() {
    setCollapsed((c) => {
      localStorage.setItem("em-ent-sidebar-collapsed", c ? "0" : "1");
      return !c;
    });
  }

  return (
    <div className="flex h-full bg-[var(--bg-page)]">
      <aside
        className={`shrink-0 h-full flex flex-col bg-[var(--bg-surface)] border-r border-[var(--hairline)] transition-[width] duration-300 ease-[cubic-bezier(0.16,1,0.3,1)] ${
          collapsed ? "w-[64px]" : "w-[244px]"
        }`}
      >
        {/* brand */}
        <div className="h-16 px-4 flex items-center justify-between border-b border-[var(--hairline)]">
          <button onClick={() => nav("/")} className="flex items-center gap-2.5 truncate">
            <Mark className="w-7 h-7 text-[var(--ink-primary)]" />
            {!collapsed && (
              <div className="truncate">
                <div className="font-mono font-medium tracking-tight text-[14px] leading-none">
                  conet
                </div>
                <div className="text-2xs uppercase tracking-micro text-[var(--ink-muted)] mt-0.5">
                  enterprise
                </div>
              </div>
            )}
          </button>
          {!collapsed && (
            <button onClick={toggle} className="em-icon-btn" title="Collapse">
              <PanelLeftClose className="w-4 h-4" />
            </button>
          )}
        </div>

        {/* tenant block */}
        {!collapsed && enterprise && (
          <div className="mx-3 mt-3 rounded-md border border-[var(--hairline)] bg-[var(--bg-elev)] px-3 py-2.5">
            <div className="text-2xs uppercase tracking-micro text-[var(--ink-muted)]">
              Tenant
            </div>
            <div className="font-medium text-sm truncate text-[var(--ink-primary)]">
              {enterprise?.name ?? "—"}
            </div>
            <div className="text-2xs text-[var(--ink-muted)] truncate font-mono">
              {enterprise?.slug}
            </div>
          </div>
        )}

        {/* nav */}
        <nav className="flex-1 overflow-y-auto py-3 px-2 space-y-0.5">
          {NAV.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.end}
              className={({ isActive }) =>
                `relative group flex items-center gap-3 h-9 px-2.5 rounded-md text-sm font-medium transition-colors ${
                  isActive
                    ? "bg-[var(--bg-elev)] text-[var(--ink-primary)]"
                    : "text-[var(--ink-secondary)] hover:text-[var(--ink-primary)] hover:bg-[var(--bg-hover)]"
                } ${collapsed ? "justify-center" : ""}`
              }
              title={collapsed ? item.label : undefined}
            >
              {({ isActive }) => (
                <>
                  {isActive && (
                    <span className="absolute left-0 top-1.5 bottom-1.5 w-[2px] bg-[var(--electric)] rounded-r" />
                  )}
                  <item.icon className="w-4 h-4 shrink-0" />
                  {!collapsed && <span className="truncate">{item.label}</span>}
                </>
              )}
            </NavLink>
          ))}
        </nav>

        {collapsed && (
          <button onClick={toggle} className="em-icon-btn mx-auto mb-3" title="Expand">
            <PanelLeftOpen className="w-4 h-4" />
          </button>
        )}

        {/* footer */}
        <div className="border-t border-[var(--hairline)] p-3 space-y-2">
          {cart.length > 0 && !collapsed && (
            <button
              onClick={() => nav("/marketplace?cart=1")}
              className="w-full em-btn-electric h-9 text-[13px]"
            >
              <ShoppingCart className="w-3.5 h-3.5" />
              Cart · {cart.length} · {fmtUsd(totals.usd * 100)}
            </button>
          )}
          {!collapsed ? (
            <button
              onClick={async () => {
                await disconnect();
                nav("/login");
              }}
              className="w-full em-btn-ghost h-9 text-[13px]"
            >
              <LogOut className="w-3.5 h-3.5" />
              Disconnect
            </button>
          ) : (
            <button
              onClick={async () => {
                await disconnect();
                nav("/login");
              }}
              className="em-icon-btn mx-auto"
              title="Disconnect"
            >
              <LogOut className="w-4 h-4" />
            </button>
          )}
        </div>
      </aside>

      <main className="flex-1 overflow-auto">
        <Outlet />
      </main>
    </div>
  );
}

function Mark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="none" aria-hidden>
      <g stroke="currentColor" strokeWidth="0.75" strokeLinecap="square" opacity="0.30">
        <line x1="5"  y1="5"  x2="19" y2="5"  />
        <line x1="5"  y1="12" x2="19" y2="12" />
        <line x1="5"  y1="19" x2="19" y2="19" />
        <line x1="5"  y1="5"  x2="5"  y2="19" />
        <line x1="12" y1="5"  x2="12" y2="19" />
        <line x1="19" y1="5"  x2="19" y2="19" />
      </g>
      <g fill="currentColor">
        <circle cx="5"  cy="5"  r="1.5" />
        <circle cx="12" cy="5"  r="1.5" />
        <circle cx="5"  cy="12" r="1.5" />
        <circle cx="12" cy="12" r="1.5" />
        <circle cx="19" cy="12" r="1.5" />
        <circle cx="5"  cy="19" r="1.5" />
        <circle cx="12" cy="19" r="1.5" />
        <circle cx="19" cy="19" r="1.5" />
      </g>
      <circle cx="19" cy="5" r="2.2" fill="#B6FF1A" />
    </svg>
  );
}
