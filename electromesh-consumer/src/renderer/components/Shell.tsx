import { Link, NavLink, Outlet, useLocation } from "react-router-dom";
import {
  LayoutDashboard,
  Cpu,
  Coins,
  Banknote,
  Settings,
  ShieldCheck,
  Smartphone
} from "lucide-react";
import { useEffect } from "react";
import { useAuth, type AuthUser } from "../state/auth";
import { useAgent } from "../state/agent";
import { cls } from "../lib/cls";

function initials(user: AuthUser | null): string {
  const name = user?.display_name || user?.email || "";
  if (!name) return "EM";
  const parts = name.split(/[\s@]+/).filter(Boolean);
  if (parts.length === 0) return "EM";
  const first = parts[0]?.[0] ?? "";
  const second = parts[1]?.[0] ?? "";
  return (first + second).toUpperCase() || (parts[0]?.slice(0, 2).toUpperCase() ?? "EM");
}

function crumbsFor(pathname: string): string[] {
  if (pathname === "/" || pathname === "") return ["Console", "Overview"];
  const segs = pathname.split("/").filter(Boolean);
  if (segs[0] === "devices" && segs[1] === "android") return ["Console", "Devices", "Pair Android"];
  if (segs[0] === "devices" && segs[1] === "lan") return ["Console", "Devices", "LAN Pairing"];
  if (segs[0] === "devices" && segs[1] === "new") return ["Console", "Devices", "New Device"];
  if (segs[0] === "devices" && segs[1]) return ["Console", "Devices", segs[1].slice(0, 8)];
  return ["Console", ...segs.map((s) => s[0]!.toUpperCase() + s.slice(1))];
}

export function Shell() {
  const { user, logout } = useAuth();
  const { status, refresh, subscribe } = useAgent();
  const location = useLocation();

  useEffect(() => {
    void refresh();
    const off = subscribe();
    return off;
  }, [refresh, subscribe]);

  const crumbs = crumbsFor(location.pathname);

  return (
    <div className="app-shell">
      <aside className="app-shell__rail">
        <Link to="/" className="brand" aria-label="ElectroMesh home">
          <span className="brand__mark">E</span>
          <span className="brand__wordmark">ELECTROMESH</span>
          <span className="brand__suffix">Console</span>
        </Link>

        <nav className="nav" aria-label="Primary">
          <span className="nav__group-label">Network</span>
          <NavLink to="/" end className={({ isActive }) => cls("nav__link", isActive && "is-active")}>
            <LayoutDashboard size={15} aria-hidden />
            Dashboard
          </NavLink>
          <NavLink to="/devices" className={({ isActive }) => cls("nav__link", isActive && "is-active")}>
            <Cpu size={15} aria-hidden />
            Devices
            <span className="nav__badge">{user?.active_device_count ?? user?.device_count ?? 0}</span>
          </NavLink>
          <NavLink to="/devices/android" className={({ isActive }) => cls("nav__link", isActive && "is-active")}>
            <Smartphone size={15} aria-hidden />
            Pair Android
          </NavLink>

          <span className="nav__group-label">Wallet</span>
          <NavLink to="/earnings" className={({ isActive }) => cls("nav__link", isActive && "is-active")}>
            <Coins size={15} aria-hidden />
            Earnings
          </NavLink>
          <NavLink to="/payouts" className={({ isActive }) => cls("nav__link", isActive && "is-active")}>
            <Banknote size={15} aria-hidden />
            Payouts
          </NavLink>

          <span className="nav__group-label">Account</span>
          <NavLink to="/settings" className={({ isActive }) => cls("nav__link", isActive && "is-active")}>
            <Settings size={15} aria-hidden />
            Settings
          </NavLink>
        </nav>

        <div className="rail-foot">
          <div className="rail-foot__identity">
            <span className="rail-foot__avatar">{initials(user)}</span>
            <div className="rail-foot__who">
              <span className="rail-foot__name">{user?.display_name || user?.email || "—"}</span>
              <span className="rail-foot__hint">{user?.country_code || "Personal"}</span>
            </div>
          </div>
          <button type="button" className="btn btn--quiet btn--sm" onClick={() => void logout()}>
            <ShieldCheck size={13} aria-hidden /> Sign out
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
          <div className={cls("topbar__agent-indicator", status.running && "is-running")}>
            <span className="dot" />
            {status.running ? "Agent live" : "Agent idle"}
          </div>
        </div>
        <Outlet />
      </div>
    </div>
  );
}
