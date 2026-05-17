import { useEffect, useState } from "react";
import { PageHeader } from "../components/PageHeader";
import { bridge } from "../api/bridge";
import { ThemeSwitcher } from "@design/theme";

export function Settings() {
  const [apiBase, setApiBase] = useState("");
  const [info, setInfo] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      const cfg = await bridge.config.get();
      setApiBase((cfg as { apiBase: string }).apiBase ?? "");
    })();
  }, []);

  async function save() {
    setInfo(null);
    await bridge.config.set({ apiBase });
    setInfo("Saved. The change applies to new requests.");
    setTimeout(() => setInfo(null), 2_000);
  }

  return (
    <div className="p-8 max-w-2xl mx-auto">
      <PageHeader title="Settings" subtitle="Connection settings for this workstation." />

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
          />
          <div className="text-[11px] text-ink-secondary mt-1">
            Point this to your conet backend (e.g. https://api.electromesh.io).
          </div>
        </div>
        <button onClick={() => void save()} className="em-btn-primary">
          Save
        </button>
        {info && <div className="text-xs text-brand-400">{info}</div>}
      </section>
    </div>
  );
}
