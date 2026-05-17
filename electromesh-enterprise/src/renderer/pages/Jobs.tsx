import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { Plus, Search } from "lucide-react";
import { bridge } from "../api/bridge";
import { StatusPill } from "../components/StatusPill";
import { EmptyState } from "../components/EmptyState";
import { formatNumber, formatRelative, formatUsd, shortId } from "../lib/format";

interface JobRow {
  id: string;
  label?: string;
  workload?: string;
  state: string;
  submitted_at?: string;
  cost_cents?: number;
  workunits_completed?: number;
  workunits_total?: number;
}

export function Jobs() {
  const nav = useNavigate();
  const [jobs, setJobs] = useState<JobRow[]>([]);
  const [filter, setFilter] = useState<"all" | "running" | "queued" | "succeeded" | "failed" | "cancelled">("all");
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  async function refresh() {
    setLoading(true); setError(null);
    try {
      const raw = await bridge.jobs.list({ limit: 200 });
      const items = Array.isArray(raw) ? raw as JobRow[] : (raw as { items?: JobRow[] })?.items || [];
      setJobs(items);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { void refresh(); }, []);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return jobs.filter((j) => {
      if (filter !== "all" && j.state !== filter) return false;
      if (!q) return true;
      return (
        (j.label || "").toLowerCase().includes(q) ||
        (j.workload || "").toLowerCase().includes(q) ||
        j.id.toLowerCase().includes(q)
      );
    });
  }, [jobs, filter, query]);

  return (
    <main className="page" data-fade>
      <header className="page-header">
        <div>
          <span className="page-header__eyebrow">Workload · Jobs</span>
          <h1 className="page-header__title">Jobs in flight</h1>
          <p className="page-header__lede">
            Every workload you've submitted, scoped to your organisation. Click
            into one for live logs, workunits and cancellation.
          </p>
        </div>
        <div className="page-header__actions">
          <Link to="/marketplace" className="btn btn--ghost">Marketplace</Link>
          <Link to="/jobs/new" className="btn btn--primary">
            <Plus size={14} aria-hidden /> Submit job
          </Link>
        </div>
      </header>

      <div className="devices-toolbar">
        <div className="cluster">
          <Search size={14} aria-hidden style={{ opacity: 0.5 }} />
          <input
            className="search"
            placeholder="Search by label, workload, or ID"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
        <div className="grow" />
        <div className="segmented" style={{ flexWrap: "wrap" }}>
          {(["all", "running", "queued", "succeeded", "failed", "cancelled"] as const).map((f) => (
            <button key={f} type="button" className={filter === f ? "is-active" : ""} onClick={() => setFilter(f)}>
              {f}
            </button>
          ))}
        </div>
      </div>

      {error && <div className="auth-error">{error}</div>}

      {loading ? (
        <div className="empty"><span className="spinner" aria-hidden /> Loading jobs…</div>
      ) : filtered.length === 0 ? (
        <EmptyState
          title="No jobs match this filter"
          body={jobs.length === 0 ? "Submit your first workload from the marketplace, or define a custom one." : "Try widening the filter."}
          cta={jobs.length === 0 ? (
            <>
              <Link to="/marketplace" className="btn btn--primary">Browse marketplace</Link>
              <Link to="/jobs/new" className="btn btn--ghost">
                <Plus size={14} aria-hidden /> Custom job
              </Link>
            </>
          ) : null}
        />
      ) : (
        <table className="t-table">
          <thead>
            <tr>
              <th>Label</th>
              <th>Workload</th>
              <th>State</th>
              <th className="num">Workunits</th>
              <th className="num">Cost</th>
              <th>Submitted</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {filtered.map((j) => (
              <tr key={j.id} onClick={() => nav(`/jobs/${j.id}`)} style={{ cursor: "pointer" }}>
                <td>
                  <strong>{j.label || j.workload || shortId(j.id)}</strong><br />
                  <span className="mono mute">{shortId(j.id)}</span>
                </td>
                <td>{j.workload || "custom"}</td>
                <td>
                  <StatusPill tone={
                    j.state === "running" ? "active" :
                    j.state === "succeeded" ? "ok" :
                    j.state === "failed" || j.state === "cancelled" ? "danger" : "quiet"
                  }>{j.state}</StatusPill>
                </td>
                <td className="num">{formatNumber(j.workunits_completed ?? 0)} / {formatNumber(j.workunits_total ?? 0)}</td>
                <td className="num">{formatUsd(j.cost_cents ?? 0)}</td>
                <td className="nowrap">{formatRelative(j.submitted_at)}</td>
                <td><span className="mute">›</span></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </main>
  );
}
