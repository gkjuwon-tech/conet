import { useEffect } from "react";
import { Link, useNavigate } from "react-router-dom";
import { ArrowRight, Plus } from "lucide-react";
import { useAuth } from "../state/auth";
import { useAgent } from "../state/agent";
import { useDevices } from "../state/devices";
import { useDashboard } from "../state/dashboard";
import { StatusPill } from "../components/StatusPill";
import { EmptyState } from "../components/EmptyState";
import { formatUsd, formatNumber, formatRelative } from "../lib/format";

export function Dashboard() {
  const { user } = useAuth();
  const { status, start, stop, starting, stopping } = useAgent();
  const { list: devices, currentId } = useDevices();
  const { snapshot, refresh } = useDashboard();
  const nav = useNavigate();

  useEffect(() => {
    void refresh();
    const t = setInterval(() => void refresh(), 30_000);
    return () => clearInterval(t);
  }, [refresh]);

  const walletBalance = snapshot?.wallet_balance_cents ?? user?.wallet_balance_cents ?? 0;
  const totalEarnings = snapshot?.total_earnings_cents ?? user?.total_earnings_cents ?? 0;
  const activeCount = snapshot?.active_device_count ?? devices.filter((d) => d.status === "active").length;
  const totalCount = snapshot?.device_count ?? devices.length;
  const workunits24 = snapshot?.total_workunits_24h ?? 0;
  const greeting = (() => {
    const h = new Date().getHours();
    if (h < 5 || h >= 22) return "Good night";
    if (h < 12) return "Good morning";
    if (h < 18) return "Good afternoon";
    return "Good evening";
  })();

  async function toggleAgent() {
    if (status.running) await stop();
    else if (currentId || devices[0]?.id) await start(currentId ?? devices[0]?.id);
  }

  const recentDevices = devices.slice(0, 4);

  return (
    <main className="page" data-fade>
      <section className="dash-hero">
        <div className="dash-hero__lede">
          <span className="greeting">{greeting}, {user?.display_name || user?.email?.split("@")[0] || "operator"}</span>
          <h1>Your mesh is up.</h1>
          <p className="lede-meta">
            {activeCount} of {totalCount} devices are checked in. The agent {status.running ? "is running" : "is idle"}.
            Last heartbeat {formatRelative(status.lastHeartbeatAt)}.
          </p>
        </div>

        <div className="dash-hero__balance">
          <span className="dash-hero__balance-label">Wallet balance</span>
          <span className="dash-hero__balance-value">{formatUsd(walletBalance)}</span>
          <span className="dash-hero__balance-meta">
            Lifetime <strong className="tabular">{formatUsd(totalEarnings)}</strong>{" "}
            {totalEarnings ? <span className="delta">▲</span> : null}
          </span>
        </div>
      </section>

      <section className="kpi-strip">
        <div className="kpi">
          <span className="kpi__label">Active devices</span>
          <span className="kpi__value">{formatNumber(activeCount)}</span>
          <span className="kpi__hint">of {totalCount} registered</span>
        </div>
        <div className="kpi">
          <span className="kpi__label">Workunits · 24h</span>
          <span className="kpi__value">{formatNumber(workunits24)}</span>
          <span className="kpi__hint">across all devices</span>
        </div>
        <div className="kpi">
          <span className="kpi__label">Agent</span>
          <span className="kpi__value">{status.running ? "RUN" : "IDLE"}</span>
          <span className="kpi__hint">
            {status.workunitsCompleted} workunits since start
          </span>
        </div>
        <div className="kpi">
          <span className="kpi__label">Pending payout</span>
          <span className="kpi__value">{formatUsd(snapshot?.payout_pending_cents ?? 0)}</span>
          <span className="kpi__hint">
            {snapshot?.next_payout_at ? `Next ${formatRelative(snapshot.next_payout_at)}` : "No schedule"}
          </span>
        </div>
      </section>

      <section className="section">
        <div className="section__head">
          <h2>Agent control</h2>
          <span className="rule" />
          <span className="right">Local · this device only</span>
        </div>
        <div className="cluster">
          <button
            type="button"
            className={`btn ${status.running ? "btn--soft" : "btn--primary"}`}
            disabled={(!devices.length) || starting || stopping}
            onClick={() => void toggleAgent()}
          >
            {status.running ? (stopping ? "Stopping…" : "Stop agent") : (starting ? "Starting…" : "Start agent")}
          </button>
          <button type="button" className="btn btn--ghost" onClick={() => nav("/devices/new")}>
            <Plus size={14} aria-hidden /> Register this device
          </button>
          <button type="button" className="btn btn--quiet" onClick={() => nav("/devices/lan")}>
            Sweep LAN
          </button>
          <span className="mute mono" style={{ marginLeft: "auto", fontSize: 11 }}>
            {status.lastError ? `Last error: ${status.lastError}` : status.running ? "Streaming heartbeats" : "Standing by"}
          </span>
        </div>
      </section>

      <section className="section">
        <div className="section__head">
          <h2>Devices</h2>
          <span className="rule" />
          <Link to="/devices" className="right">All devices →</Link>
        </div>
        {recentDevices.length === 0 ? (
          <EmptyState
            title="No devices yet"
            body="Pair a device to start earning. You can sweep your LAN in one shot or register the machine you're using now."
            cta={
              <>
                <button type="button" className="btn btn--primary" onClick={() => nav("/devices/lan")}>
                  Sweep my LAN
                </button>
                <button type="button" className="btn btn--ghost" onClick={() => nav("/devices/new")}>
                  Register this computer
                </button>
              </>
            }
          />
        ) : (
          <div className="row-list">
            {recentDevices.map((d) => (
              <div
                key={d.id}
                className="row is-clickable"
                onClick={() => nav(`/devices/${d.id}`)}
              >
                <div className="row__name">
                  <strong>{d.label || d.device_class || "Unnamed device"}</strong>
                  <span>{d.device_class.toUpperCase()} · {d.id.slice(0, 8)}</span>
                </div>
                <div className="row__cell">
                  <span className="row__cell-label">Status</span>
                  <StatusPill tone={d.status === "active" ? "active" : d.status === "decommissioned" ? "danger" : "quiet"}>
                    {d.status}
                  </StatusPill>
                </div>
                <div className="row__cell">
                  <span className="row__cell-label">Workunits · 24h</span>
                  {formatNumber(d.workunits_24h ?? 0)}
                </div>
                <div className="row__cell">
                  <span className="row__cell-label">Earnings · 30d</span>
                  {formatUsd(d.earnings_cents_30d ?? 0)}
                </div>
                <div className="row__cell">
                  <span className="row__cell-label">Last seen</span>
                  {formatRelative(d.last_seen_at)}
                </div>
                <ArrowRight size={16} aria-hidden style={{ opacity: 0.5 }} />
              </div>
            ))}
          </div>
        )}
      </section>
    </main>
  );
}
