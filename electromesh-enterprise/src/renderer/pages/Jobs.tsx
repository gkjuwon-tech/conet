import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Plus } from "lucide-react";
import { PageHeader } from "../components/PageHeader";
import { bridge, type JobPublic } from "../api/bridge";
import { fmtRelative, fmtUsd } from "../lib/format";
import { Pill } from "./Overview";

export function Jobs() {
  const nav = useNavigate();
  const [jobs, setJobs] = useState<JobPublic[]>([]);
  const [statusFilter, setStatusFilter] = useState("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void load();
    const id = setInterval(load, 10_000);
    return () => clearInterval(id);
  }, []);

  async function load() {
    const res = await bridge.jobs.list(200);
    if (res.ok) setJobs(res.data as JobPublic[]);
    else setError(res.error ?? null);
  }

  const filtered = jobs.filter((j) =>
    statusFilter ? j.status === statusFilter : true
  );

  const statuses = Array.from(new Set(jobs.map((j) => j.status))).sort();

  return (
    <div className="p-8 max-w-7xl mx-auto">
      <PageHeader
        title="Jobs"
        subtitle="Submitted jobs, both running and historical."
        action={
          <button onClick={() => nav("/jobs/new")} className="em-btn-primary">
            <Plus className="w-4 h-4" />
            New job
          </button>
        }
      />

      <div className="flex gap-2 mb-4">
        <button
          className={`em-badge ${
            statusFilter === "" ? "em-pill-active" : "em-pill-idle"
          }`}
          onClick={() => setStatusFilter("")}
        >
          All ({jobs.length})
        </button>
        {statuses.map((s) => (
          <button
            key={s}
            className={`em-badge ${
              statusFilter === s ? "em-pill-active" : "em-pill-idle"
            }`}
            onClick={() => setStatusFilter(s)}
          >
            {s} ({jobs.filter((j) => j.status === s).length})
          </button>
        ))}
      </div>

      {error && (
        <div className="text-sm text-danger-500 bg-danger-500/10 border border-danger-500/30 rounded-md p-3 mb-4">
          {error}
        </div>
      )}

      <div className="em-card overflow-hidden">
        {filtered.length === 0 ? (
          <div className="px-5 py-10 text-center text-sm text-ink-secondary">
            No jobs match this filter.
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead className="bg-bg-elev">
              <tr className="text-xs uppercase tracking-wider text-ink-secondary">
                <th className="text-left px-5 py-2 font-medium">Handle / Title</th>
                <th className="text-left px-5 py-2 font-medium">Kind</th>
                <th className="text-left px-5 py-2 font-medium">Status</th>
                <th className="text-left px-5 py-2 font-medium">Progress</th>
                <th className="text-right px-5 py-2 font-medium">Spent</th>
                <th className="text-right px-5 py-2 font-medium">Submitted</th>
                <th className="text-right px-5 py-2 font-medium">Finished</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((j) => (
                <tr
                  key={j.id}
                  className="border-t border-white/5 cursor-pointer hover:bg-bg-hover"
                  onClick={() => nav(`/jobs/${j.id}`)}
                >
                  <td className="px-5 py-3">
                    <div className="font-mono text-xs">{j.handle}</div>
                    {j.title && (
                      <div className="text-[11px] text-ink-secondary truncate max-w-[280px]">
                        {j.title}
                      </div>
                    )}
                  </td>
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
                  <td className="px-5 py-3 text-right text-xs text-ink-secondary">
                    {fmtRelative(j.finished_at)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
