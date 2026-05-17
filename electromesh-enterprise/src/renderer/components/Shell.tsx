import { Link, NavLink, Outlet, useLocation } from "react-router-dom";
import {
  Activity,
  Layers,
  Briefcase,
  KeyRound,
  Wallet,
  Settings as Cog,
  ShieldCheck
} from "lucide-react";
import { useAuth } from "../state/auth";
import { cls } from "../lib/cls";
import { formatUsd } from "../lib/format";

function initials(name: string | undefined): string {
  if (!name) return "EM";
  const parts = name.split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "EM";
  return (parts[0]![0]! + (parts[1]?.[0] ?? "")).toUpperCase();
}

function crumbsFor(pathname: string): string[] {
  if (pathname === "/" || pathname === "") return ["Operator", "Overview"];
  const segs = pathname.split("/").filter(Boolean);
  if (segs[0] === "jobs" && segs[1] === "new") return ["Operator", "Jobs", "New"];
  if (segs[0] === "jobs" && segs[1]) return ["Operator", "Jobs", segs[1].slice(0, 8)];
  return ["Operator", ...segs.map((s) => s[0]!.toUpperCase() + s.slice(1))];
}

export function Shell() {
  const { account, disconnect } = useAuth();
  const location = useLocation();
  const crumbs = crumbsFor(location.pathname);
  const balance = account?.wallet?.balance_cents ?? 0;

  return (
    <div className="app-shell">
      <aside className="app-shell__rail">
        <Link to="/" className="brand" aria-label="ElectroMesh Enterprise home">
          <span className="brand__mark">E</span>
          <span className="brand__wordmark">ELECTROMESH</span>
          <span className="brand__suffix">Operator</span>
        </Link>

        <nav className="nav" aria-label="Primary">
          <span className="nav__group-label">Workload</span>
          <NavLink to="/" end className={({ isActive }) => cls("nav__link", isActive && "is-active")}>
            <Activity size={15} aria-hidden /> Overview
          </NavLink>
          <NavLink to="/marketplace" className={({ isActive }) => cls("nav__link", isActive && "is-active")}>
            <Layers size={15} aria-hidden /> Marketplace
          </NavLink>
          <NavLink to="/jobs" className={({ isActive }) => cls("nav__link", isActive && "is-active")}>
            <Briefcase size={15} aria-hidden /> Jobs
          </NavLink>

          <span className="nav__group-label">Account</span>
          <NavLink to="/wallet" className={({ isActive }) => cls("nav__link", isActive && "is-active")}>
            <Wallet size={15} aria-hidden /> Wallet
          </NavLink>
          <NavLink to="/api-keys" className={({ isActive }) => cls("nav__link", isActive && "is-active")}>
            <KeyRound size={15} aria-hidden /> API keys
          </NavLink>
          <NavLink to="/settings" className={({ isActive }) => cls("nav__link", isActive && "is-active")}>
            <Cog size={15} aria-hidden /> Settings
          </NavLink>
        </nav>

        <div className="rail-foot">
          <div className="rail-foot__identity">
            <span className="rail-foot__avatar">{initials(account?.name ?? account?.org?.name)}</span>
            <div className="rail-foot__who">
              <span className="rail-foot__name">{account?.name ?? account?.org?.name ?? "Operator"}</span>
              <span className="rail-foot__hint">{account?.org?.id?.slice(0, 8) ?? "—"}</span>
            </div>
          </div>
          <button type="button" className="btn btn--quiet btn--sm" onClick={() => void disconnect()}>
            <ShieldCheck size={13} aria-hidden /> Disconnect
          </button>
        </div>
      </aside>

      <div className="app-shell__main">
        <div className="topbar">
          <div className="topbar__crumbs">
            {crumbs.map((c, i) => (
              <span key={`${c}-${i}`}>{c}{i < crumbs.length - 1 ? " · " : ""}</span>
            ))}
          </div>
          <div className="topbar__spacer" />
          <div className="topbar__balance">
            <span className="topbar__balance-label">Wallet</span>
            <span className="topbar__balance-value">{formatUsd(balance)}</span>
          </div>
        </div>
        <Outlet />
      </div>
    </div>
  );
}
