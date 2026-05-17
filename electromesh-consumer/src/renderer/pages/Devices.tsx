import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Plus, Search, Wifi } from "lucide-react";
import { useDevices } from "../state/devices";
import { StatusPill } from "../components/StatusPill";
import { EmptyState } from "../components/EmptyState";
import { formatNumber, formatRelative, formatUsd } from "../lib/format";

export function Devices() {
  const { list, refresh, loading, error, currentId, setCurrent } = useDevices();
  const nav = useNavigate();
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<"all" | "active" | "offline">("all");

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return list.filter((d) => {
      if (filter === "active" && d.status !== "active") return false;
      if (filter === "offline" && d.status === "active") return false;
      if (!q) return true;
      return (
        (d.label || "").toLowerCase().includes(q) ||
        d.device_class.toLowerCase().includes(q) ||
        d.id.toLowerCase().includes(q)
      );
    });
  }, [list, query, filter]);

  return (
    <main className="page" data-fade>
      <header className="page-header">
        <div>
          <span className="page-header__eyebrow">Network · Devices</span>
          <h1 className="page-header__title">Your devices</h1>
          <p className="page-header__lede">
            Every device you've paired to the mesh. Click a card to drill into
            health, earnings and benchmarks. Set one as "current" so the
            console-local agent runs on its identity.
          </p>
        </div>
        <div className="page-header__actions">
          <button type="button" className="btn btn--ghost" onClick={() => nav("/devices/lan")}>
            <Wifi size={14} aria-hidden /> Sweep LAN
          </button>
          <button type="button" className="btn btn--primary" onClick={() => nav("/devices/new")}>
            <Plus size={14} aria-hidden /> New device
          </button>
        </div>
      </header>

      <div className="devices-toolbar">
        <div className="cluster">
          <Search size={14} aria-hidden style={{ opacity: 0.5 }} />
          <input
            className="search"
            placeholder="Search by name, class, or ID"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
        <div className="grow" />
        <div className="segmented">
          {(["all", "active", "offline"] as const).map((f) => (
            <button
              key={f}
              type="button"
              className={filter === f ? "is-active" : ""}
              onClick={() => setFilter(f)}
            >
              {f}
            </button>
          ))}
        </div>
      </div>

      {error && <div className="auth-error">{error}</div>}

      {!loading && filtered.length === 0 ? (() => {
        const hasDevices = list.length > 0;
        const hasQuery = query.trim().length > 0;
        // "Empty list" and "filter knocked them all out" are different stories
        // to the user. The latter shouldn't tell them to register a device —
        // they already have some.
        let title: string;
        let body: string;
        let cta: React.ReactNode = null;

        if (!hasDevices) {
          title = "No devices yet";
          body = "Sweep your LAN to find everything in one shot, or register the computer you're using right now.";
          cta = (
            <>
              <button type="button" className="btn btn--primary" onClick={() => nav("/devices/lan")}>
                Sweep my LAN
              </button>
              <button type="button" className="btn btn--ghost" onClick={() => nav("/devices/new")}>
                Register this computer
              </button>
            </>
          );
        } else if (hasQuery) {
          title = "No matches for that search";
          body = `Nothing matches "${query.trim()}". Clear the search or widen the filter.`;
          cta = (
            <button type="button" className="btn btn--ghost" onClick={() => setQuery("")}>
              Clear search
            </button>
          );
        } else if (filter === "active") {
          title = "Nothing's active right now";
          body = "All paired devices are idle or offline. Active devices appear here as soon as their agent checks in.";
          cta = (
            <button type="button" className="btn btn--ghost" onClick={() => setFilter("all")}>
              Show all devices
            </button>
          );
        } else if (filter === "offline") {
          title = "Nothing's offline";
          body = "Every paired device is currently checking in. Devices that miss heartbeats land here.";
          cta = (
            <button type="button" className="btn btn--ghost" onClick={() => setFilter("all")}>
              Show all devices
            </button>
          );
        } else {
          title = "No matches for that filter";
          body = "Try clearing the search or switching back to All.";
        }

        return <EmptyState title={title} body={body} cta={cta} />;
      })() : (
        <div className="device-grid">
          {filtered.map((d) => {
            const isCurrent = d.id === currentId;
            return (
              <article
                key={d.id}
                className="device-card"
                onClick={() => nav(`/devices/${d.id}`)}
              >
                <header className="device-card__head">
                  <div className="device-card__name">
                    <strong>{d.label || d.device_class}</strong>
                    <span>{d.device_class.toUpperCase()} · {d.id.slice(0, 8)}</span>
                  </div>
                  <StatusPill tone={d.status === "active" ? "active" : d.status === "decommissioned" ? "danger" : "quiet"}>
                    {d.status}
                  </StatusPill>
                </header>

                <div className="device-card__metrics">
                  <div className="device-card__metric">
                    <span className="device-card__metric-label">Workunits · 24h</span>
                    <span className="device-card__metric-value">{formatNumber(d.workunits_24h ?? 0)}</span>
                  </div>
                  <div className="device-card__metric">
                    <span className="device-card__metric-label">Earnings · 30d</span>
                    <span className="device-card__metric-value">{formatUsd(d.earnings_cents_30d ?? 0)}</span>
                  </div>
                  <div className="device-card__metric">
                    <span className="device-card__metric-label">Trust</span>
                    <span className="device-card__metric-value">{d.trust_score?.toFixed(2) ?? "—"}</span>
                  </div>
                  <div className="device-card__metric">
                    <span className="device-card__metric-label">Last seen</span>
                    <span className="device-card__metric-value">{formatRelative(d.last_seen_at)}</span>
                  </div>
                </div>

                <div className="cluster">
                  {isCurrent ? (
                    <StatusPill tone="active" withDot={false}>Current</StatusPill>
                  ) : (
                    <button
                      type="button"
                      className="btn btn--quiet btn--sm"
                      onClick={(e) => {
                        e.stopPropagation();
                        void setCurrent(d.id);
                      }}
                    >
                      Set as current
                    </button>
                  )}
                </div>
              </article>
            );
          })}
        </div>
      )}
    </main>
  );
}
