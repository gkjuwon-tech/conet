import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Plus, Cpu, Wifi, Power, BarChart3, Radio, Smartphone } from "lucide-react";
import { PageHeader } from "../components/PageHeader";
import { useAgent } from "../state/agent";
import { bridge } from "../api/bridge";
import {
  DEVICE_CLASS_LABEL,
  DEVICE_STATUS_PILL,
  fmtH100,
  fmtPct,
  fmtRelative,
  fmtUsd
} from "../lib/format";
import type { DeviceSummary } from "../api/bridge";

export function Devices() {
  const { devices, refreshAll, status, start, stop } = useAgent();
  const nav = useNavigate();
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    void refreshAll();
  }, [refreshAll]);

  return (
    <div className="p-12 max-w-6xl mx-auto">
      <PageHeader
        title="Devices"
        subtitle="Each registered device contributes to your earnings."
        action={
          <div className="flex gap-3">
            <button
              onClick={() => nav("/devices/lan-wizard")}
              className="em-btn-primary"
            >
              <Radio className="w-4 h-4" />
              Scan WiFi & pair
            </button>
            <button
              onClick={() => nav("/devices/android")}
              className="em-btn-ghost"
            >
              <Smartphone className="w-4 h-4" />
              Pair Android
            </button>
            <button onClick={() => nav("/devices/new")} className="em-btn-ghost">
              <Plus className="w-4 h-4" />
              Pair this PC
            </button>
          </div>
        }
      />

      {devices.length === 0 ? (
        <div className="em-card p-14 text-center">
          <Cpu className="mx-auto w-12 h-12 text-ink-secondary mb-4" />
          <div className="text-xl font-medium mb-2">No devices yet</div>
          <div className="text-base text-ink-secondary mb-6">
            Run the LAN wizard to pair every device on your Wi-Fi at once, or
            register just this computer.
          </div>
          <div className="flex gap-3 justify-center">
            <button onClick={() => nav("/devices/lan-wizard")} className="em-btn-primary">
              <Radio className="w-4 h-4" />
              Scan my WiFi
            </button>
            <button onClick={() => nav("/devices/new")} className="em-btn-ghost">
              <Plus className="w-4 h-4" />
              Just this PC
            </button>
          </div>
        </div>
      ) : (
        <div className="grid grid-cols-2 gap-6">
          {devices.map((d) => (
            <DeviceCard
              key={d.id}
              device={d}
              isCurrent={status.deviceId === d.id}
              busy={busy === d.id}
              onSetCurrent={async () => {
                setBusy(d.id);
                if (status.running) await stop();
                await bridge.devices.setCurrent(d.id);
                const err = await start(d.id);
                if (err) console.warn(err);
                await refreshAll();
                setBusy(null);
              }}
              onBenchmark={async () => {
                setBusy(d.id);
                const res = await bridge.devices.benchmark(d.id);
                if (!res.ok) console.warn(res.error);
                await refreshAll();
                setBusy(null);
              }}
              onDecommission={async () => {
                if (!confirm(`Decommission "${d.label || d.handle}"?`)) return;
                setBusy(d.id);
                await bridge.devices.decommission(d.id);
                await refreshAll();
                setBusy(null);
              }}
              onOpen={() => nav(`/devices/${d.id}`)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function DeviceCard({
  device,
  isCurrent,
  busy,
  onSetCurrent,
  onBenchmark,
  onDecommission,
  onOpen
}: {
  device: DeviceSummary;
  isCurrent: boolean;
  busy: boolean;
  onSetCurrent: () => Promise<void>;
  onBenchmark: () => Promise<void>;
  onDecommission: () => Promise<void>;
  onOpen: () => void;
}) {
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
    <div className="em-card em-card-hover p-6">
      <div className="flex items-start justify-between">
        <button
          type="button"
          onClick={onOpen}
          className="text-left flex-1 selectable"
        >
          <div className="font-medium truncate">
            {device.label || device.handle}
          </div>
          <div className="text-xs text-ink-secondary">
            {DEVICE_CLASS_LABEL[device.device_class] ?? device.device_class} ·{" "}
            {device.model ?? "unknown model"}
          </div>
        </button>
        <span className={pillClass}>{device.status}</span>
      </div>

      <dl className="grid grid-cols-3 gap-4 mt-5">
        <Stat label="Compute" value={fmtH100(device.h100_equivalent)} />
        <Stat label="Reliability" value={fmtPct(device.reliability_score)} />
        <Stat label="Trust" value={fmtPct(device.trust_score)} />
        <Stat label="Lifetime" value={fmtUsd(device.revenue_cents_lifetime)} />
        <Stat label="Workunits" value={device.workunits_completed.toLocaleString()} />
        <Stat label="Last seen" value={fmtRelative(device.last_seen_at)} />
      </dl>

      <div className="mt-6 flex flex-wrap gap-3">
        {isCurrent ? (
          <span className="em-pill-active">
            <Wifi className="w-3 h-3" />
            Active on this app
          </span>
        ) : null}
        <button
          disabled={busy}
          onClick={() => void onDecommission()}
          className="em-btn-danger ml-auto"
        >
          <Power className="w-4 h-4" />
          Decommission
        </button>
      </div>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="em-eyebrow">
        {label}
      </dt>
      <dd className="font-mono text-sm tabular">{value}</dd>
    </div>
  );
}
