import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  Activity,
  CheckCircle2,
  Clock,
  ShoppingBag,
  TrendingUp,
  Plus
} from "lucide-react";
import { PageHeader } from "../components/PageHeader";
import { StatCard } from "../components/StatCard";
import { bridge, type Enterprise, type JobPublic, type Stats } from "../api/bridge";
import {
  fmtNumber,
  fmtPct,
  fmtRelative,
  fmtUsd,
  JOB_STATUS_PILL
} from "../lib/format";

export function Overview() {
  const nav = useNavigate();
  const [enterprise, setEnterprise] = useState<Enterprise | null>(null);
  const [stats, setStats] = useState<Stats | null>(null);
  const [jobs, setJobs] = useState<JobPublic[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void load();
    const id = setInterval(load, 15_000);
    return () => clearInterval(id);
  }, []);

  async function load() {
    const [statsRes, jobsRes] = await Promise.all([
      bridge.stats.fetch(),
      bridge.jobs.list(20)
    ]);
    if (statsRes.ok) {
      const data = statsRes.data as { enterprise: Enterprise; stats: Stats };
      setEnterprise(data.enterprise);
      setStats(data.stats);
    } else {
      setError(statsRes.error ?? null);
    }
    if (jobsRes.ok) setJobs(jobsRes.data as JobPublic[]);
  }

  const spendCap = enterprise?.spend_cap_cents;
  const spendCapPct =
    spendCap && spendCap > 0
      ? Math.min(100, ((enterprise?.monthly_spend_cents ?? 0) / spendCap) * 100)
      : null;

  return (
    <div className="p-8 max-w-7xl mx-auto">
      <PageHeader
        title="Overview"
        subtitle="Live tenant snapshot — capacity, spend, and active jobs."
        action={
          <div className="flex gap-2">
            <button
              onClick={() => nav("/marketplace")}
              className="em-btn-ghost"
            >
              <ShoppingBag className="w-4 h-4" />
              Marketplace
            </button>
            <button
              onClick={() => nav("/jobs/new")}
              className="em-btn-primary"
            >
              <Plus className="w-4 h-4" />
              New job
            </button>
          </div>
        }
      />

      {error && (
        <div className="text-sm text-danger-500 bg-danger-500/10 border border-danger-500/30 rounded-md p-3 mb-4">
          {error}
        </div>
      )}

      <div className="grid grid-cols-4 gap-4 mb-6">
        <StatCard
          label="Active jobs"
          value={fmtNumber(stats?.jobs_active ?? 0, 0)}
          accent="brand"
          hint="Currently running or leasing"
        />
        <StatCard
          label="30-day spend"
          value={fmtUsd(stats?.spend_30d_cents ?? 0)}
          hint={
            spendCapPct !== null
              ? `${spendCapPct.toFixed(0)}% of cap`
              : "no spend cap configured"
          }
        />
        <StatCard
          label="Success rate (30d)"
          value={fmtPct(stats?.success_rate_30d ?? 0)}
          hint={`${stats?.jobs_completed_30d ?? 0} jobs succeeded`}
        />
        <StatCard
          label="Avg job runtime (30d)"
          value={
            stats?.avg_runtime_seconds_30d
              ? `${(stats.avg_runtime_seconds_30d / 60).toFixed(1)} min`
              : "—"
          }
        />
      </div>

      <section className="em-card overflow-hidden">
        <div className="px-5 py-4 border-b border-white/5 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Activity className="w-4 h-4 text-brand-500" />
            <h2 className="font-semibold text-sm">Recent jobs</h2>
          </div>
          <button
            onClick={() => nav("/jobs")}
            className="text-xs text-brand-400 hover:text-brand-500"
          >
            View all →
          </button>
        </div>
        {jobs.length === 0 ? (
          <div className="px-5 py-10 text-center text-sm text-ink-secondary">
            No jobs yet. Browse the marketplace to lease compute and submit
            your first job.
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead className="bg-bg-elev">
              <tr className="text-xs uppercase tracking-wider text-ink-secondary">
                <th className="text-left px-5 py-2 font-medium">Handle</th>
                <th className="text-left px-5 py-2 font-medium">Kind</th>
                <th className="text-left px-5 py-2 font-medium">Status</th>
                <th className="text-left px-5 py-2 font-medium">Progress</th>
                <th className="text-right px-5 py-2 font-medium">Spent</th>
                <th className="text-right px-5 py-2 font-medium">Submitted</th>
              </tr>
            </thead>
            <tbody>
              {jobs.slice(0, 10).map((j) => (
                <tr
                  key={j.id}
                  className="border-t border-white/5 cursor-pointer hover:bg-bg-hover"
                  onClick={() => nav(`/jobs/${j.id}`)}
                >
                  <td className="px-5 py-3 font-mono text-xs">{j.handle}</td>
                  <td className="px-5 py-3 text-xs">{j.kind}</td>
                  <td className="px-5 py-3">
                    <Pill status={j.status} />
                  </td>
                  <td className="px-5 py-3 text-xs">
                    {j.workunit_total > 0 ? (
                      <div className="flex items-center gap-2 max-w-[160px]">
                        <div className="flex-1 h-1.5 bg-bg-elev rounded-full overflow-hidden">
                          <div
                            className="h-full bg-brand-500"
                            style={{
                              width: `${(j.workunit_completed / j.workunit_total) * 100}%`
                            }}
                          />
                        </div>
                        <span className="text-ink-secondary">
                          {j.workunit_completed}/{j.workunit_total}
                        </span>
                      </div>
                    ) : (
                      "—"
                    )}
                  </td>
                  <td className="px-5 py-3 text-right font-mono">
                    {fmtUsd(j.spent_cents)}
                  </td>
                  <td className="px-5 py-3 text-right text-xs text-ink-secondary">
                    {fmtRelative(j.submitted_at)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}

export function Pill({ status }: { status: string }) {
  const variant = JOB_STATUS_PILL[status] ?? "idle";
  const cls =
    variant === "active"
      ? "em-pill-active"
      : variant === "warn"
        ? "em-pill-warn"
        : variant === "danger"
          ? "em-pill-danger"
          : "em-pill-idle";
  const Icon =
    variant === "active"
      ? CheckCircle2
      : variant === "warn"
        ? Clock
        : variant === "danger"
          ? TrendingUp
          : Clock;
  return (
    <span className={cls}>
      <Icon className="w-3 h-3" />
      {status}
    </span>
  );
}
