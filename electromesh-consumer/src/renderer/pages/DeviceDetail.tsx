import { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useDevices } from "../state/devices";
import { useAgent } from "../state/agent";
import { bridge } from "../api/bridge";
import { StatusPill } from "../components/StatusPill";
import { Modal } from "../components/Modal";
import {
  formatHashrate,
  formatNumber,
  formatRelative,
  formatUsd,
  shortId
} from "../lib/format";

interface DeviceDetail {
  id: string;
  label?: string | null;
  device_class?: string;
  status?: string;
  trust_score?: number;
  hashrate_mhs?: number;
  ram_mb?: number;
  power_w?: number;
  last_seen_at?: string | null;
  cpu_model?: string;
  workunits_24h?: number;
  workunits_30d?: number;
  earnings_cents_30d?: number;
  ledger?: Array<{ ts: string; kind: string; amount_cents: number; description?: string }>;
}

export function DeviceDetail() {
  const params = useParams<{ id: string }>();
  const nav = useNavigate();
  const id = params.id!;
  const { currentId, setCurrent, decommission, refresh } = useDevices();
  const { start, stop, status } = useAgent();
  const [device, setDevice] = useState<DeviceDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [benching, setBenching] = useState(false);
  const [benchProgress, setBenchProgress] = useState<string>("");
  const [confirmDecom, setConfirmDecom] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    bridge.api.call<DeviceDetail>({ path: `/v1/devices/${id}` })
      .then((data) => { if (!cancelled) setDevice(data); })
      .catch((err) => { if (!cancelled) setError(err instanceof Error ? err.message : String(err)); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [id]);

  useEffect(() => {
    const off = bridge.devices.onBenchmarkProgress((payload) => {
      const p = payload as { phase?: string; pct?: number; detail?: string };
      if (p && p.detail) setBenchProgress(p.detail);
    });
    return () => { off; };
  }, []);

  async function runBenchmark() {
    if (!device) return;
    setBenching(true);
    setBenchProgress("Initializing…");
    try {
      const result = await bridge.devices.benchmark(device.id);
      setDevice({ ...device, hashrate_mhs: result.hashrate_mhs, ram_mb: result.ram_mb, power_w: result.power_w });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBenching(false);
      setBenchProgress("");
    }
  }

  async function toggleAgent() {
    if (!device) return;
    if (status.running) await stop();
    else await start(device.id);
  }

  async function onDecommission() {
    if (!device) return;
    setConfirmDecom(false);
    await decommission(device.id);
    await refresh();
    nav("/devices");
  }

  if (loading) return <main className="page"><span className="spinner" /> Loading device…</main>;
  if (error) return <main className="page"><div className="auth-error">{error}</div></main>;
  if (!device) return <main className="page"><div className="empty"><div className="empty__title">Device not found</div></div></main>;

  const isCurrent = device.id === currentId;

  return (
    <main className="page" data-fade>
      <header className="page-header">
        <div>
          <span className="page-header__eyebrow">Device · {shortId(device.id)}</span>
          <h1 className="page-header__title">{device.label || device.device_class || "Unnamed device"}</h1>
          <p className="page-header__lede">
            {(device.cpu_model || "Unknown CPU")} · paired {formatRelative(device.last_seen_at)} ago
          </p>
        </div>
        <div className="page-header__actions">
          {!isCurrent && (
            <button type="button" className="btn btn--quiet" onClick={() => void setCurrent(device.id)}>
              Set as current
            </button>
          )}
          <button type="button" className="btn btn--ghost" disabled={benching} onClick={() => void runBenchmark()}>
            {benching ? `Benchmarking — ${benchProgress || "running"}` : "Re-benchmark"}
          </button>
          <button type="button" className="btn btn--primary" onClick={() => void toggleAgent()}>
            {status.running && status.deviceId === device.id ? "Stop agent" : "Start agent here"}
          </button>
          <button type="button" className="btn btn--danger" onClick={() => setConfirmDecom(true)}>
            Decommission
          </button>
        </div>
      </header>

      <section className="kpi-strip">
        <div className="kpi">
          <span className="kpi__label">Status</span>
          <span className="kpi__value">
            <StatusPill tone={device.status === "active" ? "active" : "quiet"}>{device.status || "—"}</StatusPill>
          </span>
          <span className="kpi__hint">Trust {device.trust_score?.toFixed(2) ?? "—"}</span>
        </div>
        <div className="kpi">
          <span className="kpi__label">Hashrate</span>
          <span className="kpi__value">{formatHashrate(device.hashrate_mhs)}</span>
          <span className="kpi__hint">Last benchmark</span>
        </div>
        <div className="kpi">
          <span className="kpi__label">Workunits · 24h</span>
          <span className="kpi__value">{formatNumber(device.workunits_24h ?? 0)}</span>
          <span className="kpi__hint">{formatNumber(device.workunits_30d ?? 0)} · 30d</span>
        </div>
        <div className="kpi">
          <span className="kpi__label">Earnings · 30d</span>
          <span className="kpi__value">{formatUsd(device.earnings_cents_30d ?? 0)}</span>
          <span className="kpi__hint">{device.power_w ? `${device.power_w}W est.` : ""}</span>
        </div>
      </section>

      <section className="section">
        <div className="section__head">
          <h2>Ledger</h2>
          <span className="rule" />
          <span className="right">Last 50 events</span>
        </div>
        {device.ledger && device.ledger.length > 0 ? (
          <table className="t-table">
            <thead>
              <tr>
                <th>When</th>
                <th>Kind</th>
                <th>Description</th>
                <th className="num">Amount</th>
              </tr>
            </thead>
            <tbody>
              {device.ledger.slice(0, 50).map((row, idx) => (
                <tr key={idx}>
                  <td className="nowrap">{formatRelative(row.ts)}</td>
                  <td><StatusPill tone="quiet" withDot={false}>{row.kind}</StatusPill></td>
                  <td>{row.description || ""}</td>
                  <td className="num">{formatUsd(row.amount_cents)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <div className="empty"><div className="empty__title">No ledger entries yet</div></div>
        )}
      </section>

      <Modal
        open={confirmDecom}
        title="Decommission this device?"
        body="Once decommissioned, the agent will stop and the device token will be revoked. You can re-register it later if needed."
        onClose={() => setConfirmDecom(false)}
        actions={
          <>
            <button type="button" className="btn btn--quiet" onClick={() => setConfirmDecom(false)}>Cancel</button>
            <button type="button" className="btn btn--danger" onClick={() => void onDecommission()}>Decommission</button>
          </>
        }
      />
    </main>
  );
}
