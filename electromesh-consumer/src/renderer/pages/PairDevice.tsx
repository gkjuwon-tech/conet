import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Cpu, Loader2, Check } from "lucide-react";
import { PageHeader } from "../components/PageHeader";
import { bridge } from "../api/bridge";
import { DEVICE_CLASS_LABEL, fmtBytes } from "../lib/format";
import { useAgent } from "../state/agent";

interface SystemSnapshot {
  hostname: string;
  platform: string;
  arch: string;
  os: string;
  cpuCores: number;
  cpuGhz: number;
  cpuModel: string;
  ramMb: number;
  storageGb: number;
  gpuModel: string | null;
  gpuVramMb: number;
  defaultGatewayMac: string | null;
  lanFingerprint: string;
  inferredDeviceClass: string;
}

const STEPS = ["detect", "consents", "register", "benchmark", "live"] as const;
type Step = (typeof STEPS)[number];

export function PairDevice() {
  const nav = useNavigate();
  const [step, setStep] = useState<Step>("detect");
  const [snapshot, setSnapshot] = useState<SystemSnapshot | null>(null);
  const [label, setLabel] = useState("");
  const [deviceClass, setDeviceClass] = useState("desktop");
  const [maxCpu, setMaxCpu] = useState(10);
  const [allowGpu, setAllowGpu] = useState(false);
  const [nightOnly, setNightOnly] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [deviceId, setDeviceId] = useState<string | null>(null);
  const [progress, setProgress] = useState<{ phase: string; pct: number; detail?: string } | null>(null);
  const { start, refreshAll } = useAgent();

  useEffect(() => {
    void (async () => {
      const sys = (await bridge.system.snapshot()) as SystemSnapshot;
      setSnapshot(sys);
      setLabel(sys.hostname);
      setDeviceClass(sys.inferredDeviceClass);
      setStep("consents");
    })();
  }, []);

  useEffect(() => {
    const off = bridge.benchmark.onProgress(
      (p: { phase: string; pct: number; detail?: string }) => setProgress(p)
    );
    return () => {
      off();
    };
  }, []);

  async function doRegister() {
    if (!snapshot) return;
    setBusy(true);
    setError(null);
    const res = await bridge.devices.register({
      label,
      device_class: deviceClass,
      consents: {
        compute_share: true,
        network_share: true,
        storage_share: false,
        night_only: nightOnly,
        max_cpu_pct: maxCpu,
        max_gpu_pct: allowGpu ? maxCpu : 0,
        max_bandwidth_mbps: 5,
        blackout_hours: []
      },
      capabilities: {
        sha256: true,
        argon2: true,
        ml_inference: false,
        fhe: false,
        mpc: false,
        render: false,
        secure_enclave: false,
        tpm: false
      }
    });
    setBusy(false);
    if (!res.ok) {
      setError(res.error ?? "registration failed");
      return;
    }
    setDeviceId(res.device.id);
    setStep("benchmark");
    await runBenchmark(res.device.id);
  }

  async function runBenchmark(id: string) {
    setBusy(true);
    setError(null);
    const res = await bridge.devices.benchmark(id);
    setBusy(false);
    if (!res.ok) {
      setError(res.error ?? "benchmark failed");
      return;
    }
    setStep("live");
    await refreshAll();
    const errStart = await start(id);
    if (errStart) setError(errStart);
  }

  return (
    <div className="p-8 max-w-3xl mx-auto">
      <PageHeader
        title="Pair this device"
        subtitle="conet runs background workloads only when your hardware is idle."
      />

      <ol className="flex items-center gap-2 mb-6 text-xs text-ink-secondary">
        {(["consents", "register", "benchmark", "live"] as Step[]).map((s, idx) => (
          <li key={s} className="flex items-center gap-2">
            <span
              className={`w-6 h-6 rounded-full flex items-center justify-center text-[11px] ${
                step === s
                  ? "bg-brand-500 text-black"
                  : STEPS.indexOf(step) > STEPS.indexOf(s)
                    ? "bg-brand-500/30 text-brand-500"
                    : "bg-bg-elev"
              }`}
            >
              {STEPS.indexOf(step) > STEPS.indexOf(s) ? (
                <Check className="w-3 h-3" />
              ) : (
                idx + 1
              )}
            </span>
            <span className="capitalize">{s}</span>
            {idx < 3 && <span className="w-6 border-t border-white/10" />}
          </li>
        ))}
      </ol>

      {!snapshot ? (
        <div className="em-card p-10 grid place-items-center">
          <Loader2 className="w-8 h-8 animate-spin text-ink-secondary" />
          <div className="mt-3 text-sm text-ink-secondary">
            Detecting hardware…
          </div>
        </div>
      ) : (
        <>
          <section className="em-card p-5 mb-4">
            <div className="text-xs text-ink-secondary mb-3">Detected hardware</div>
            <div className="grid grid-cols-3 gap-3 text-sm">
              <Spec label="Hostname" value={snapshot.hostname} />
              <Spec
                label="Platform"
                value={`${snapshot.os} · ${snapshot.arch}`}
              />
              <Spec
                label="CPU"
                value={`${snapshot.cpuCores}× @ ${snapshot.cpuGhz.toFixed(1)} GHz`}
              />
              <Spec label="CPU model" value={snapshot.cpuModel} />
              <Spec label="RAM" value={fmtBytes(snapshot.ramMb)} />
              <Spec label="Storage" value={`${snapshot.storageGb} GB`} />
              <Spec label="GPU" value={snapshot.gpuModel ?? "—"} />
              <Spec
                label="VRAM"
                value={snapshot.gpuVramMb ? fmtBytes(snapshot.gpuVramMb) : "—"}
              />
              <Spec
                label="LAN fp"
                value={snapshot.lanFingerprint.slice(0, 12) + "…"}
              />
            </div>
          </section>

          {step === "consents" && (
            <section className="em-card p-5 mb-4 space-y-5">
              <div>
                <label className="em-label">Device label</label>
                <input
                  className="em-input"
                  value={label}
                  onChange={(e) => setLabel(e.target.value)}
                />
              </div>
              <div>
                <label className="em-label">Device class</label>
                <select
                  className="em-input"
                  value={deviceClass}
                  onChange={(e) => setDeviceClass(e.target.value)}
                >
                  {Object.entries(DEVICE_CLASS_LABEL).map(([v, l]) => (
                    <option key={v} value={v}>
                      {l}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="em-label">Max CPU share ({maxCpu}%)</label>
                <input
                  type="range"
                  min={1}
                  max={50}
                  value={maxCpu}
                  onChange={(e) => setMaxCpu(Number(e.target.value))}
                  className="w-full"
                />
                <div className="text-[11px] text-ink-secondary">
                  conet will never exceed this CPU usage. The agent
                  pauses automatically when foreground apps need the CPU.
                </div>
              </div>
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={allowGpu}
                  onChange={(e) => setAllowGpu(e.target.checked)}
                />
                Allow GPU usage when present
              </label>
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={nightOnly}
                  onChange={(e) => setNightOnly(e.target.checked)}
                />
                Only run between 0:00–6:00 local time
              </label>

              {error && (
                <div className="text-sm text-danger-500">{error}</div>
              )}

              <button
                disabled={busy}
                onClick={() => void doRegister()}
                className="em-btn-primary"
              >
                {busy ? "Registering…" : "Register and benchmark"}
              </button>
            </section>
          )}

          {step === "benchmark" && (
            <section className="em-card p-5 mb-4">
              <div className="font-medium mb-2">Benchmarking your device</div>
              <div className="text-xs text-ink-secondary mb-4">
                We're estimating CPU/SHA-256 throughput, memory-hard hashing,
                and network. The agent will take over after this.
              </div>
              <BenchProgress progress={progress} />
              {error && (
                <div className="mt-4 text-sm text-danger-500">{error}</div>
              )}
            </section>
          )}

          {step === "live" && deviceId && (
            <section className="em-card p-6 mb-4 grid place-items-center">
              <div className="w-12 h-12 rounded-full bg-brand-500/20 grid place-items-center mb-3">
                <Cpu className="w-6 h-6 text-brand-500" />
              </div>
              <div className="text-lg font-semibold">You're earning!</div>
              <div className="text-sm text-ink-secondary mt-1 text-center max-w-md">
                The agent will start receiving work assignments within a minute.
                You can pause anytime from the dashboard.
              </div>
              <div className="mt-5 flex gap-2">
                <button
                  className="em-btn-primary"
                  onClick={() => nav("/")}
                >
                  Open dashboard
                </button>
                <button
                  className="em-btn-ghost"
                  onClick={() => nav(`/devices/${deviceId}`)}
                >
                  Device details
                </button>
              </div>
            </section>
          )}
        </>
      )}
    </div>
  );
}

function BenchProgress({
  progress
}: {
  progress: { phase: string; pct: number; detail?: string } | null;
}) {
  const phases = ["cpu", "hash", "argon", "network", "done"];
  return (
    <div className="space-y-3">
      {phases.map((phase) => {
        const active = progress?.phase === phase;
        const done = phases.indexOf(progress?.phase ?? "cpu") > phases.indexOf(phase);
        const pct = active ? progress.pct : done ? 100 : 0;
        return (
          <div key={phase}>
            <div className="flex justify-between text-xs">
              <span className="capitalize">{phase}</span>
              <span className="text-ink-secondary">
                {active ? progress.detail : done ? "complete" : "queued"}
              </span>
            </div>
            <div className="h-1.5 bg-bg-elev rounded-full overflow-hidden mt-1">
              <div
                className={`h-full transition-all ${
                  done ? "bg-brand-500" : "bg-brand-500/70"
                }`}
                style={{ width: `${pct}%` }}
              />
            </div>
          </div>
        );
      })}
    </div>
  );
}

function Spec({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-wider text-ink-secondary">
        {label}
      </div>
      <div className="font-mono text-xs truncate selectable">{value}</div>
    </div>
  );
}
