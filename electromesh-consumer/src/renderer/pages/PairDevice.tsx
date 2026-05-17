import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useDevices } from "../state/devices";
import { useAgent } from "../state/agent";
import { bridge } from "../api/bridge";
import { formatBytes, formatHashrate } from "../lib/format";

interface SystemInfo {
  hostname: string;
  os: string;
  cpuModel: string;
  cpuPhysical: number;
  cpuLogical: number;
  ramTotalMb: number;
}

export function PairDevice() {
  const { register } = useDevices();
  const { start } = useAgent();
  const nav = useNavigate();
  const [info, setInfo] = useState<SystemInfo | null>(null);
  const [label, setLabel] = useState("");
  const [accepted, setAccepted] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [bench, setBench] = useState<{ hashrate_mhs: number; ram_mb: number } | null>(null);
  const [progress, setProgress] = useState<string>("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    bridge.system.info().then((sys) => {
      setInfo(sys);
      if (!label) setLabel(sys.hostname);
    }).catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, [label]);

  useEffect(() => {
    const off = bridge.devices.onBenchmarkProgress((p) => {
      const pp = p as { detail?: string };
      if (pp.detail) setProgress(pp.detail);
    });
    return () => { off; };
  }, []);

  async function submit() {
    if (!info) return;
    setSubmitting(true);
    setError(null);
    try {
      const dev = await register({
        label: label.trim() || info.hostname,
        device_class: "laptop",
        capabilities: {
          cpu_model: info.cpuModel,
          cpu_cores: info.cpuLogical,
          ram_mb: info.ramTotalMb,
          os: info.os
        },
        consents: {
          tos_accepted: true,
          local_agent: true
        }
      });
      setProgress("Running first benchmark…");
      const bres = await bridge.devices.benchmark(dev.id);
      setBench({ hashrate_mhs: bres.hashrate_mhs, ram_mb: bres.ram_mb });
      setProgress("Starting agent…");
      await start(dev.id);
      nav(`/devices/${dev.id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
      setProgress("");
    }
  }

  return (
    <main className="page" data-fade>
      <header className="page-header">
        <div>
          <span className="page-header__eyebrow">Devices · Register</span>
          <h1 className="page-header__title">Register this computer</h1>
          <p className="page-header__lede">
            We detected your hardware. Give the device a label, confirm consent,
            and the agent will benchmark + start earning whenever your CPU has
            headroom.
          </p>
        </div>
      </header>

      {error && <div className="auth-error">{error}</div>}

      <section className="wizard">
        <div className="wizard__rail">
          <div className="wizard-step is-done">
            <span className="wizard-step__num">✓</span>
            <div className="wizard-step__body">
              <span className="wizard-step__title">Detect</span>
              <span className="wizard-step__lede">Hardware fingerprint</span>
            </div>
          </div>
          <div className="wizard-step is-active">
            <span className="wizard-step__num">2</span>
            <div className="wizard-step__body">
              <span className="wizard-step__title">Consent</span>
              <span className="wizard-step__lede">Label & opt-in</span>
            </div>
          </div>
          <div className="wizard-step is-pending">
            <span className="wizard-step__num">3</span>
            <div className="wizard-step__body">
              <span className="wizard-step__title">Benchmark</span>
              <span className="wizard-step__lede">~30s hash bench</span>
            </div>
          </div>
          <div className="wizard-step is-pending">
            <span className="wizard-step__num">4</span>
            <div className="wizard-step__body">
              <span className="wizard-step__title">Go live</span>
              <span className="wizard-step__lede">Agent online</span>
            </div>
          </div>
        </div>

        <div className="wizard__panel">
          <h2>Confirm hardware</h2>
          {info ? (
            <dl className="kpi-strip" style={{ gridTemplateColumns: "repeat(4, 1fr)" }}>
              <div className="kpi">
                <span className="kpi__label">Hostname</span>
                <span className="kpi__value" style={{ fontSize: 18 }}>{info.hostname}</span>
                <span className="kpi__hint">{info.os}</span>
              </div>
              <div className="kpi">
                <span className="kpi__label">CPU</span>
                <span className="kpi__value" style={{ fontSize: 14 }}>{info.cpuModel || "Unknown CPU"}</span>
                <span className="kpi__hint">{info.cpuLogical} logical / {info.cpuPhysical} cores</span>
              </div>
              <div className="kpi">
                <span className="kpi__label">RAM</span>
                <span className="kpi__value">{formatBytes(info.ramTotalMb)}</span>
                <span className="kpi__hint">Total installed</span>
              </div>
              <div className="kpi">
                <span className="kpi__label">Hashrate</span>
                <span className="kpi__value">{bench ? formatHashrate(bench.hashrate_mhs) : "—"}</span>
                <span className="kpi__hint">{progress || (bench ? "After benchmark" : "TBD")}</span>
              </div>
            </dl>
          ) : (
            <span className="spinner" />
          )}

          <div className="field">
            <label htmlFor="dev-label">Device label</label>
            <input
              id="dev-label"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder={info?.hostname || "My laptop"}
            />
            <span className="field-hint">Visible to you only. Defaults to hostname.</span>
          </div>

          <label className="cluster" style={{ alignItems: "flex-start", lineHeight: 1.6 }}>
            <input
              type="checkbox"
              checked={accepted}
              onChange={(e) => setAccepted(e.target.checked)}
              style={{ marginTop: 4 }}
            />
            <span className="lede">
              I confirm I own this device, I understand the agent will use idle
              CPU cycles to earn for me, and I accept the ElectroMesh terms of
              service.
            </span>
          </label>

          <div className="wizard-actions">
            <span className="wizard-actions__hint">
              {info ? "Ready to register" : "Waiting for hardware…"}
            </span>
            <button type="button" className="btn btn--ghost" onClick={() => nav(-1)}>Back</button>
            <button
              type="button"
              className="btn btn--primary"
              disabled={!info || !accepted || submitting}
              onClick={() => void submit()}
            >
              {submitting ? (progress || "Registering…") : "Register & start agent"}
            </button>
          </div>
        </div>
      </section>
    </main>
  );
}
