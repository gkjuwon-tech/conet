import { useEffect, useState } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { ArrowLeft, BarChart3, Power } from "lucide-react";
import { PageHeader } from "../components/PageHeader";
import { bridge, type DeviceDetail as DeviceDetailT } from "../api/bridge";
import {
  DEVICE_CLASS_LABEL,
  DEVICE_STATUS_PILL,
  fmtBytes,
  fmtH100,
  fmtNumber,
  fmtPct,
  fmtRelative,
  fmtUsd
} from "../lib/format";
import { useAgent } from "../state/agent";

export function DeviceDetail() {
  const { id } = useParams<{ id: string }>();
  const nav = useNavigate();
  const [device, setDevice] = useState<DeviceDetailT | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { refreshAll, status } = useAgent();

  useEffect(() => {
    if (!id) return;
    void load();

    function load() {
      bridge
        .apiCall({ method: "GET", path: `/v1/devices/${id}` })
        .then((res: { ok: boolean; data?: unknown; error?: string }) => {
          if (res.ok) setDevice(res.data as DeviceDetailT);
          else setError(res.error ?? "load failed");
        });
    }
    const t = setInterval(load, 12_000);
    return () => clearInterval(t);
  }, [id]);

  if (!id) return null;
  if (!device)
    return (
      <div className="p-8">
        <PageHeader title="Device" />
        <div className="text-sm text-ink-secondary">{error ?? "Loading…"}</div>
      </div>
    );

  const pillVariant = DEVICE_STATUS_PILL[device.status] ?? "idle";
  const pillClass =
    pillVariant === "active"
      ? "em-pill-active"
      : pillVariant === "warn"
        ? "em-pill-warn"
        : pillVariant === "danger"
          ? "em-pill-danger"
          : "em-pill-idle";

  return (
    <div className="p-8 max-w-5xl mx-auto">
      <button
        onClick={() => nav("/devices")}
        className="flex items-center gap-1 text-sm text-ink-secondary hover:text-ink-primary mb-3"
      >
        <ArrowLeft className="w-4 h-4" />
        Back to devices
      </button>

      <PageHeader
        title={device.label || device.handle}
        subtitle={`${DEVICE_CLASS_LABEL[device.device_class] ?? device.device_class} · ${device.handle}`}
        action={
          <div className="flex items-center gap-3">
            <span className={pillClass}>{device.status}</span>
            <button
              disabled={busy}
              className="em-btn-danger"
              onClick={async () => {
                if (!confirm("Decommission this device?")) return;
                setBusy(true);
                await bridge.devices.decommission(device.id);
                await refreshAll();
                nav("/devices");
              }}
            >
              <Power className="w-4 h-4" />
              Decommission
            </button>
          </div>
        }
      />

      {error && (
        <div className="text-sm text-danger-500 mb-4">{error}</div>
      )}

      <div className="grid grid-cols-3 gap-4 mb-6">
        <Stat label="H100 equivalent" value={fmtH100(device.h100_equivalent)} />
        <Stat label="Lifetime earned" value={fmtUsd(device.revenue_cents_lifetime)} />
        <Stat label="Workunits done" value={device.workunits_completed.toLocaleString()} />
        <Stat label="Reliability" value={fmtPct(device.reliability_score)} />
        <Stat label="Trust" value={fmtPct(device.trust_score)} />
        <Stat label="Last seen" value={fmtRelative(device.last_seen_at)} />
      </div>

      <section className="em-card p-5 mb-4">
        <h2 className="font-semibold mb-3">Hardware profile</h2>
        <div className="grid grid-cols-3 gap-4 text-sm">
          <Spec label="CPU" value={`${device.cpu_cores}× @ ${device.cpu_ghz.toFixed(1)} GHz`} />
          <Spec label="RAM" value={fmtBytes(device.ram_mb)} />
          <Spec label="Storage" value={`${device.storage_gb} GB`} />
          <Spec label="GPU" value={device.gpu_model ?? "—"} />
          <Spec label="VRAM" value={device.gpu_vram_mb ? fmtBytes(device.gpu_vram_mb) : "—"} />
          <Spec label="CPU GFLOPS" value={fmtNumber(device.cpu_gflops, 1)} />
          <Spec label="GPU GFLOPS" value={fmtNumber(device.gpu_gflops, 1)} />
          <Spec label="SHA-256" value={`${fmtNumber(device.hash_mhs_sha256, 2)} MH/s`} />
          <Spec label="Argon2" value={`${fmtNumber(device.hash_mhs_argon2, 4)} MH/s`} />
          <Spec
            label="Network"
            value={`${fmtNumber(device.network_mbps_down)} ↓ / ${fmtNumber(device.network_mbps_up)} ↑ Mbps`}
          />
          <Spec label="Latency" value={`${fmtNumber(device.network_latency_ms)} ms`} />
          <Spec label="Last benchmark" value={fmtRelative(device.last_benchmark_at)} />
        </div>
      </section>

      <section className="em-card p-5">
        <h2 className="font-semibold mb-3">Consents</h2>
        <pre className="text-xs bg-bg-elev p-3 rounded-lg overflow-x-auto selectable">
          {JSON.stringify(device.consents, null, 2)}
        </pre>
      </section>

      {status.deviceId === device.id && status.units.length > 0 && (
        <section className="em-card p-5 mt-4">
          <h2 className="font-semibold mb-3">Live work units</h2>
          <ul className="space-y-2">
            {status.units.map((u) => (
              <li key={u.workunit_id} className="text-xs">
                <div className="flex justify-between">
                  <code className="text-ink-secondary truncate max-w-[60%]">
                    {u.workunit_id}
                  </code>
                  <span>{u.progress_pct.toFixed(0)}%</span>
                </div>
                <div className="h-1 bg-bg-elev rounded-full overflow-hidden mt-1">
                  <div
                    className="h-full bg-brand-500"
                    style={{ width: `${u.progress_pct}%` }}
                  />
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}
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
      <div className="font-mono text-sm selectable">{value}</div>
    </div>
  );
}
