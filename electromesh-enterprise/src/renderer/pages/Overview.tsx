import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { Plus, ArrowRight } from "lucide-react";
import { bridge } from "../api/bridge";
import { useAuth } from "../state/auth";
import { StatusPill } from "../components/StatusPill";
import { EmptyState } from "../components/EmptyState";
import { formatNumber, formatRelative, formatUsd } from "../lib/format";

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

interface WalletInfo {
  balance_cents?: number;
  pending_cents?: number;
  spend_30d_cents?: number;
  ledger?: Array<{ ts: string; description?: string; amount_cents: number; kind?: string }>;
}

export function Overview() {
  const { account } = useAuth();
  const [jobs, setJobs] = useState<JobRow[]>([]);
  const [wallet, setWallet] = useState<WalletInfo | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    Promise.all([
      bridge.jobs.list({ limit: 6 }),
      bridge.wallet.balance()
    ])
      .then(([j, w]) => {
        if (cancelled) return;
        const items = Array.isArray(j)
          ? j as JobRow[]
          : (j as { items?: JobRow[] })?.items || [];
        setJobs(items);
        setWallet(w as WalletInfo);
      })
      .catch((err) => { if (!cancelled) setError(err instanceof Error ? err.message : String(err)); });
    return () => { cancelled = true; };
  }, []);

  const balance = wallet?.balance_cents ?? account?.wallet?.balance_cents ?? 0;
  const pending = wallet?.pending_cents ?? 0;
  const spend30 = wallet?.spend_30d_cents ?? 0;
  const activeJobs = jobs.filter((j) => j.state === "running" || j.state === "queued").length;

  return (
    <main className="page" data-fade>
      <section className="dash-hero">
        <div className="dash-hero__lede">
          <span className="greeting">{account?.name ?? account?.org?.name ?? "Operator"}</span>
          <h1>Workload control room.</h1>
          <p className="lede-meta">
            {jobs.length} jobs in flight · {activeJobs} active · last sync {formatRelative(Date.now())}
          </p>
        </div>
        <div className="dash-hero__balance">
          <span className="dash-hero__balance-label">Wallet balance</span>
          <span className="dash-hero__balance-value">{formatUsd(balance)}</span>
          <span className="dash-hero__balance-meta">
            30d spend <strong className="tabular">{formatUsd(spend30)}</strong>
          </span>
        </div>
      </section>

      {error && <div className="auth-error">{error}</div>}

      <section className="kpi-strip">
        <div className="kpi">
          <span className="kpi__label">Balance</span>
          <span className="kpi__value">{formatUsd(balance)}</span>
          <span className="kpi__hint">Available now</span>
        </div>
        <div className="kpi">
          <span className="kpi__label">Pending</span>
          <span className="kpi__value">{formatUsd(pending)}</span>
          <span className="kpi__hint">In-flight commitments</span>
        </div>
        <div className="kpi">
          <span className="kpi__label">Active jobs</span>
          <span className="kpi__value">{formatNumber(activeJobs)}</span>
          <span className="kpi__hint">{jobs.length} total visible</span>
        </div>
        <div className="kpi">
          <span className="kpi__label">30d spend</span>
          <span className="kpi__value">{formatUsd(spend30)}</span>
          <span className="kpi__hint">Cumulative</span>
        </div>
      </section>

      <section className="section">
        <div className="section__head">
          <h2>Recent jobs</h2>
          <span className="rule" />
          <Link to="/jobs" className="right">All jobs →</Link>
        </div>
        {jobs.length === 0 ? (
          <EmptyState
            title="No jobs yet"
            body="Spin up a workload — pick a recipe from the marketplace or define a custom job from scratch."
            cta={
              <>
                <Link to="/marketplace" className="btn btn--primary">Browse marketplace</Link>
                <Link to="/jobs/new" className="btn btn--ghost">
                  <Plus size={14} aria-hidden /> Custom job
                </Link>
              </>
            }
          />
        ) : (
          <div className="row-list">
            {jobs.map((j) => (
              <Link key={j.id} to={`/jobs/${j.id}`} className="row is-clickable">
                <div className="row__name">
                  <strong>{j.label || j.workload || j.id.slice(0, 10)}</strong>
                  <span>{j.workload || "custom"} · {j.id.slice(0, 8)}</span>
                </div>
                <div className="row__cell">
                  <span className="row__cell-label">State</span>
                  <StatusPill tone={
                    j.state === "running" ? "active" :
                    j.state === "succeeded" ? "ok" :
                    j.state === "failed" || j.state === "cancelled" ? "danger" : "quiet"
                  }>{j.state}</StatusPill>
                </div>
                <div className="row__cell">
                  <span className="row__cell-label">Workunits</span>
                  {formatNumber(j.workunits_completed ?? 0)} / {formatNumber(j.workunits_total ?? 0)}
                </div>
                <div className="row__cell">
                  <span className="row__cell-label">Cost</span>
                  {formatUsd(j.cost_cents ?? 0)}
                </div>
                <div className="row__cell">
                  <span className="row__cell-label">Submitted</span>
                  {formatRelative(j.submitted_at)}
                </div>
                <ArrowRight size={16} aria-hidden style={{ opacity: 0.5 }} />
              </Link>
            ))}
          </div>
        )}
      </section>
    </main>
  );
}
