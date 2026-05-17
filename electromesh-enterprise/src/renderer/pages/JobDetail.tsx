import { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { ArrowLeft, Ban, CheckCircle2 } from "lucide-react";
import { PageHeader } from "../components/PageHeader";
import { bridge, type JobDetail as JobDetailT, type WorkUnitPublic } from "../api/bridge";
import { fmtNumber, fmtRelative, fmtUsd } from "../lib/format";
import { Pill } from "./Overview";

export function JobDetailPage() {
  const { id } = useParams<{ id: string }>();
  const nav = useNavigate();
  const [job, setJob] = useState<JobDetailT | null>(null);
  const [workunits, setWorkunits] = useState<WorkUnitPublic[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!id) return;
    void load();
    const t = setInterval(load, 5_000);
    return () => clearInterval(t);
  }, [id]);

  async function load() {
    if (!id) return;
    const [jobRes, wuRes] = await Promise.all([
      bridge.jobs.get(id),
      bridge.jobs.workunits(id)
    ]);
    if (jobRes.ok) setJob(jobRes.data as JobDetailT);
    else setError(jobRes.error ?? null);
    if (wuRes.ok) setWorkunits(wuRes.data as WorkUnitPublic[]);
  }

  if (!id) return null;
  if (!job) {
    return (
      <div className="p-8">
        <PageHeader title="Job" />
        <div className="text-sm text-ink-secondary">{error ?? "Loading…"}</div>
      </div>
    );
  }

  const progressPct =
    job.workunit_total > 0
      ? (job.workunit_completed / job.workunit_total) * 100
      : 0;

  const isTerminal = ["succeeded", "failed", "cancelled", "timed_out"].includes(job.status);
  const isCancelable = !isTerminal;

  return (
    <div className="p-8 max-w-6xl mx-auto">
      <button
        onClick={() => nav("/jobs")}
        className="flex items-center gap-1 text-sm text-ink-secondary hover:text-ink-primary mb-3"
      >
        <ArrowLeft className="w-4 h-4" />
        All jobs
      </button>

      <PageHeader
        title={job.title || job.handle}
        subtitle={`${job.kind} · ${job.handle}`}
        action={
          <div className="flex gap-2 items-center">
            <Pill status={job.status} />
            {isCancelable && (
              <button
                disabled={busy}
                onClick={async () => {
                  if (!confirm("Cancel this job?")) return;
                  setBusy(true);
                  await bridge.jobs.cancel(job.id, "cancelled by user");
                  await load();
                  setBusy(false);
                }}
                className="em-btn-danger"
              >
                <Ban className="w-4 h-4" />
                Cancel
              </button>
            )}
            <button
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                const res = await bridge.jobs.finalize(job.id);
                if (!res.ok) setError(res.error ?? null);
                await load();
                setBusy(false);
              }}
              className="em-btn-ghost"
            >
              <CheckCircle2 className="w-4 h-4" />
              Finalize / settle
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
        <Stat label="Workunits" value={`${job.workunit_completed} / ${job.workunit_total}`} />
        <Stat label="Failed" value={fmtNumber(job.workunit_failed, 0)} />
        <Stat label="Spent" value={fmtUsd(job.spent_cents)} />
        <Stat label="Paid to users" value={fmtUsd(job.paid_to_users_cents)} />
      </div>

      <div className="em-card p-5 mb-4">
        <div className="flex items-center justify-between mb-2">
          <div className="text-sm font-semibold">Progress</div>
          <div className="text-xs text-ink-secondary">{progressPct.toFixed(1)}%</div>
        </div>
        <div className="h-2 bg-bg-elev rounded-full overflow-hidden">
          <div
            className="h-full bg-brand-500"
            style={{ width: `${progressPct}%` }}
          />
        </div>
        <div className="grid grid-cols-4 gap-3 mt-4 text-xs">
          <Spec label="Submitted" value={fmtRelative(job.submitted_at)} />
          <Spec label="Started" value={fmtRelative(job.started_at)} />
          <Spec label="Deadline" value={fmtRelative(job.deadline_at)} />
          <Spec label="Finished" value={fmtRelative(job.finished_at)} />
        </div>
      </div>

      <div className="grid grid-cols-2 gap-4 mb-4">
        <section className="em-card p-5">
          <div className="text-sm font-semibold mb-2">Input manifest</div>
          <pre className="text-xs bg-bg-elev p-3 rounded-lg overflow-x-auto selectable max-h-[260px]">
            {JSON.stringify(job.input_manifest, null, 2)}
          </pre>
        </section>
        <section className="em-card p-5">
          <div className="text-sm font-semibold mb-2">Isolation policy</div>
          <pre className="text-xs bg-bg-elev p-3 rounded-lg overflow-x-auto selectable">
            {JSON.stringify(job.isolation_policy, null, 2)}
          </pre>
        </section>
      </div>

      <section className="em-card overflow-hidden">
        <div className="px-5 py-4 border-b border-white/5 flex items-center justify-between">
          <div className="text-sm font-semibold">Workunits</div>
          <div className="text-xs text-ink-secondary">{workunits.length} total</div>
        </div>
        {workunits.length === 0 ? (
          <div className="px-5 py-6 text-sm text-ink-secondary">
            No workunits enumerated yet.
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead className="bg-bg-elev">
              <tr className="text-xs uppercase tracking-wider text-ink-secondary">
                <th className="text-left px-5 py-2 font-medium">Seq</th>
                <th className="text-left px-5 py-2 font-medium">Status</th>
                <th className="text-left px-5 py-2 font-medium">Redundancy</th>
                <th className="text-left px-5 py-2 font-medium">Consensus</th>
                <th className="text-left px-5 py-2 font-medium">Result hash</th>
                <th className="text-right px-5 py-2 font-medium">Dispatched</th>
                <th className="text-right px-5 py-2 font-medium">Done</th>
              </tr>
            </thead>
            <tbody>
              {workunits.slice(0, 100).map((w) => (
                <tr key={w.id} className="border-t border-white/5">
                  <td className="px-5 py-2 font-mono text-xs">{w.sequence_no}</td>
                  <td className="px-5 py-2">
                    <Pill status={w.status} />
                  </td>
                  <td className="px-5 py-2 text-xs">
                    {w.redundancy_satisfied}/{w.redundancy_required}
                  </td>
                  <td className="px-5 py-2 text-xs">
                    {w.consensus_score !== null
                      ? `${(w.consensus_score * 100).toFixed(0)}%`
                      : "—"}
                  </td>
                  <td className="px-5 py-2 font-mono text-[11px] truncate max-w-[160px]">
                    {w.final_result_hash ?? "—"}
                  </td>
                  <td className="px-5 py-2 text-right text-xs text-ink-secondary">
                    {fmtRelative(w.dispatched_at)}
                  </td>
                  <td className="px-5 py-2 text-right text-xs text-ink-secondary">
                    {fmtRelative(w.completed_at)}
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

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="em-card p-4">
      <div className="text-[11px] uppercase text-ink-secondary tracking-wider">
        {label}
      </div>
      <div className="text-xl font-semibold mt-1">{value}</div>
    </div>
  );
}

function Spec({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-[10px] uppercase text-ink-secondary tracking-wider">
        {label}
      </div>
      <div className="font-mono text-xs">{value}</div>
    </div>
  );
}
