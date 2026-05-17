import { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { bridge } from "../api/bridge";
import { StatusPill } from "../components/StatusPill";
import { Modal } from "../components/Modal";
import { formatNumber, formatRelative, formatUsd, shortId } from "../lib/format";

interface JobDetail {
  id: string;
  label?: string;
  workload?: string;
  state: string;
  submitted_at?: string;
  finished_at?: string;
  cost_cents?: number;
  workunits_total?: number;
  workunits_completed?: number;
  workunits_failed?: number;
  region?: string;
  recipe_id?: string;
  parameters?: Record<string, unknown>;
}

interface LogLine { ts?: string; level?: string; line: string }
interface Workunit { id: string; state: string; runtime_ms?: number; cost_cents?: number; device_id?: string; finished_at?: string }

export function JobDetail() {
  const { id } = useParams<{ id: string }>();
  const nav = useNavigate();
  const [job, setJob] = useState<JobDetail | null>(null);
  const [logs, setLogs] = useState<LogLine[]>([]);
  const [workunits, setWorkunits] = useState<Workunit[]>([]);
  const [tab, setTab] = useState<"summary" | "logs" | "workunits">("summary");
  const [error, setError] = useState<string | null>(null);
  const [confirmCancel, setConfirmCancel] = useState(false);
  const [cancelling, setCancelling] = useState(false);

  useEffect(() => {
    if (!id) return;
    let cancelled = false;
    setError(null);
    Promise.all([
      bridge.jobs.get(id),
      bridge.jobs.logs(id),
      bridge.jobs.workunits(id)
    ])
      .then(([j, l, w]) => {
        if (cancelled) return;
        setJob(j as JobDetail);
        const lines = Array.isArray(l) ? l as LogLine[] : (l as { lines?: LogLine[] })?.lines || [];
        setLogs(lines);
        const wus = Array.isArray(w) ? w as Workunit[] : (w as { items?: Workunit[] })?.items || [];
        setWorkunits(wus);
      })
      .catch((err) => { if (!cancelled) setError(err instanceof Error ? err.message : String(err)); });
    return () => { cancelled = true; };
  }, [id]);

  async function cancel() {
    if (!id) return;
    setCancelling(true); setError(null);
    try {
      await bridge.jobs.cancel(id);
      const j = await bridge.jobs.get(id) as JobDetail;
      setJob(j);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setCancelling(false);
      setConfirmCancel(false);
    }
  }

  if (error && !job) return <main className="page"><div className="auth-error">{error}</div></main>;
  if (!job) return <main className="page"><span className="spinner" /> Loading job…</main>;

  const pct = job.workunits_total
    ? Math.round(((job.workunits_completed ?? 0) / job.workunits_total) * 100)
    : 0;
  const canCancel = job.state === "running" || job.state === "queued";

  return (
    <main className="page" data-fade>
      <header className="page-header">
        <div>
          <span className="page-header__eyebrow">Job · {shortId(job.id)}</span>
          <h1 className="page-header__title">{job.label || job.workload || job.id}</h1>
          <p className="page-header__lede">
            {job.workload || "custom"} · {job.region ?? "global"} · submitted {formatRelative(job.submitted_at)} ago
          </p>
        </div>
        <div className="page-header__actions">
          <button type="button" className="btn btn--ghost" onClick={() => nav(-1)}>Back</button>
          {canCancel && (
            <button type="button" className="btn btn--danger" onClick={() => setConfirmCancel(true)}>
              Cancel job
            </button>
          )}
        </div>
      </header>

      {error && <div className="auth-error">{error}</div>}

      <section className="kpi-strip">
        <div className="kpi">
          <span className="kpi__label">State</span>
          <span className="kpi__value">
            <StatusPill tone={
              job.state === "running" ? "active" :
              job.state === "succeeded" ? "ok" :
              job.state === "failed" || job.state === "cancelled" ? "danger" : "quiet"
            }>{job.state}</StatusPill>
          </span>
          <span className="kpi__hint">{job.finished_at ? `Finished ${formatRelative(job.finished_at)}` : "Live"}</span>
        </div>
        <div className="kpi">
          <span className="kpi__label">Progress</span>
          <span className="kpi__value">{pct}%</span>
          <span className="kpi__hint">{formatNumber(job.workunits_completed ?? 0)} / {formatNumber(job.workunits_total ?? 0)}</span>
        </div>
        <div className="kpi">
          <span className="kpi__label">Failed</span>
          <span className="kpi__value">{formatNumber(job.workunits_failed ?? 0)}</span>
          <span className="kpi__hint">Workunits</span>
        </div>
        <div className="kpi">
          <span className="kpi__label">Cost</span>
          <span className="kpi__value">{formatUsd(job.cost_cents ?? 0)}</span>
          <span className="kpi__hint">So far</span>
        </div>
      </section>

      <div className="segmented" style={{ alignSelf: "flex-start" }}>
        {(["summary", "logs", "workunits"] as const).map((t) => (
          <button key={t} type="button" className={tab === t ? "is-active" : ""} onClick={() => setTab(t)}>
            {t}
          </button>
        ))}
      </div>

      {tab === "summary" && (
        <section className="section">
          <div className="section__head">
            <h2>Parameters</h2>
            <span className="rule" />
          </div>
          {job.parameters && Object.keys(job.parameters).length > 0 ? (
            <dl className="kv">
              {Object.entries(job.parameters).map(([k, v]) => (
                <div key={k}>
                  <dt>{k}</dt>
                  <dd className="mono">{typeof v === "object" ? JSON.stringify(v) : String(v)}</dd>
                </div>
              ))}
            </dl>
          ) : (
            <p className="lede mute">No parameters recorded.</p>
          )}
        </section>
      )}

      {tab === "logs" && (
        <section className="section">
          <div className="section__head">
            <h2>Logs</h2>
            <span className="rule" />
            <span className="right">{logs.length} lines</span>
          </div>
          {logs.length === 0 ? (
            <p className="lede mute">No log lines yet.</p>
          ) : (
            <div className="log-stream">
              {logs.map((l, i) => (
                <div key={i} className="log-line">
                  <span className="log-line__ts">{l.ts ? new Date(l.ts).toLocaleTimeString() : ""}</span>
                  <span className={`log-line__level log-line__level--${l.level ?? "info"}`}>{l.level ?? "info"}</span>
                  <span className="log-line__msg">{l.line}</span>
                </div>
              ))}
            </div>
          )}
        </section>
      )}

      {tab === "workunits" && (
        <section className="section">
          <div className="section__head">
            <h2>Workunits</h2>
            <span className="rule" />
            <span className="right">{workunits.length} total</span>
          </div>
          {workunits.length === 0 ? (
            <p className="lede mute">No workunits dispatched yet.</p>
          ) : (
            <table className="t-table">
              <thead>
                <tr><th>ID</th><th>State</th><th>Device</th><th className="num">Runtime</th><th className="num">Cost</th><th>Finished</th></tr>
              </thead>
              <tbody>
                {workunits.map((w) => (
                  <tr key={w.id}>
                    <td className="mono">{shortId(w.id)}</td>
                    <td><StatusPill tone={w.state === "succeeded" ? "ok" : w.state === "failed" ? "danger" : "quiet"}>{w.state}</StatusPill></td>
                    <td className="mono">{shortId(w.device_id)}</td>
                    <td className="num">{w.runtime_ms ? `${(w.runtime_ms / 1000).toFixed(2)}s` : "—"}</td>
                    <td className="num">{formatUsd(w.cost_cents ?? 0)}</td>
                    <td className="nowrap">{formatRelative(w.finished_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
      )}

      <Modal
        open={confirmCancel}
        title="Cancel this job?"
        body="Workunits currently in flight will run to completion, but no new ones will be dispatched. You will be billed for completed workunits only."
        onClose={() => setConfirmCancel(false)}
        actions={
          <>
            <button type="button" className="btn btn--quiet" onClick={() => setConfirmCancel(false)}>Keep running</button>
            <button type="button" className="btn btn--danger" disabled={cancelling} onClick={() => void cancel()}>
              {cancelling ? "Cancelling…" : "Cancel job"}
            </button>
          </>
        }
      />
    </main>
  );
}
