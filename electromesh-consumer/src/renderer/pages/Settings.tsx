import { useEffect, useState } from "react";
import { PageHeader } from "../components/PageHeader";
import { bridge } from "../api/bridge";
import { ThemeSwitcher } from "@design/theme";

export function Settings() {
  const [apiBase, setApiBase] = useState("");
  const [autoStart, setAutoStart] = useState(true);
  const [minimizeToTray, setMinimizeToTray] = useState(true);
  const [allowGpu, setAllowGpu] = useState(false);
  const [nightOnly, setNightOnly] = useState(false);
  const [maxCpu, setMaxCpu] = useState(10);
  const [info, setInfo] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      const cfg = await bridge.config.get();
      setApiBase((cfg as { apiBase: string }).apiBase ?? "");
      const prefs = (cfg as { preferences: Record<string, unknown> }).preferences ?? {};
      setAutoStart((prefs.autoStart as boolean) ?? true);
      setMinimizeToTray((prefs.minimizeToTray as boolean) ?? true);
      setAllowGpu((prefs.allowGpu as boolean) ?? false);
      setNightOnly((prefs.nightOnly as boolean) ?? false);
      setMaxCpu((prefs.maxCpuPct as number) ?? 10);
    })();
  }, []);

  async function save() {
    setInfo(null);
    await bridge.config.set({
      apiBase,
      preferences: {
        autoStart,
        minimizeToTray,
        allowGpu,
        nightOnly,
        maxCpuPct: maxCpu
      }
    });
    setInfo("Settings saved.");
    setTimeout(() => setInfo(null), 2_000);
  }

  return (
    <div className="p-8 max-w-2xl mx-auto">
      <PageHeader
        title="Settings"
        subtitle="Local preferences. Most changes take effect immediately."
      />

      <section className="em-card p-6 mb-4">
        <div className="flex items-center justify-between">
          <div>
            <label className="em-label" style={{ marginBottom: 0 }}>Appearance</label>
            <div className="text-xs text-ink-secondary mt-1">
              Three themes — pick whatever's easier on your eyes.
            </div>
          </div>
          <ThemeSwitcher />
        </div>
      </section>

      <section className="em-card p-6 space-y-5">
        <div>
          <label className="em-label">API base URL</label>
          <input
            className="em-input"
            value={apiBase}
            onChange={(e) => setApiBase(e.target.value)}
            placeholder="http://localhost:8080"
          />
          <div className="text-[11px] text-ink-secondary mt-1">
            Point this to your conet backend. Changes apply to new requests
            immediately — no restart required.
          </div>
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
        </div>

        <Toggle
          label="Auto-start the agent at launch"
          value={autoStart}
          onChange={setAutoStart}
        />
        <Toggle
          label="Minimize to system tray on close"
          value={minimizeToTray}
          onChange={setMinimizeToTray}
        />
        <Toggle
          label="Allow GPU usage"
          value={allowGpu}
          onChange={setAllowGpu}
        />
        <Toggle
          label="Run only at night (00:00–06:00 local)"
          value={nightOnly}
          onChange={setNightOnly}
        />

        <div className="flex items-center gap-3 pt-3 border-t border-white/5">
          <button onClick={() => void save()} className="em-btn-primary">
            Save
          </button>
          {info && <span className="text-xs text-brand-400">{info}</span>}
        </div>
      </section>
    </div>
  );
}

function Toggle({
  label,
  value,
  onChange
}: {
  label: string;
  value: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <label className="flex items-center justify-between gap-3 cursor-pointer">
      <span className="text-sm">{label}</span>
      <input
        type="checkbox"
        checked={value}
        onChange={(e) => onChange(e.target.checked)}
        className="w-5 h-5 accent-brand-500"
      />
    </label>
  );
}
