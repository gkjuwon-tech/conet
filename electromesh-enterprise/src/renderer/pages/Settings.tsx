import { useEffect, useState } from "react";
import { useAuth } from "../state/auth";
import { bridge } from "../api/bridge";

interface Prefs {
  theme?: "dark" | "light" | "ivory";
  notifications?: boolean;
  defaultRegion?: string;
}

export function Settings() {
  const { account, disconnect } = useAuth();
  const [apiBase, setApiBase] = useState("");
  const [prefs, setPrefs] = useState<Prefs>({});
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    bridge.config.get()
      .then((cfg) => {
        setApiBase(cfg.apiBase);
        setPrefs(cfg.preferences as Prefs);
      })
      .catch((err) => setError(err instanceof Error ? err.message : String(err)));
  }, []);

  async function save() {
    setSaving(true); setError(null);
    try {
      await bridge.config.set({ apiBase, preferences: prefs });
      setSavedAt(Date.now());
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  function applyTheme(t: "dark" | "light" | "ivory") {
    try {
      document.documentElement.setAttribute("data-theme", t);
      localStorage.setItem("conet:theme", t);
    } catch {
      /* ignore */
    }
    setPrefs((p) => ({ ...p, theme: t }));
  }

  return (
    <main className="page" data-fade>
      <header className="page-header">
        <div>
          <span className="page-header__eyebrow">Account · Settings</span>
          <h1 className="page-header__title">Operator preferences</h1>
          <p className="page-header__lede">
            Backend endpoint, appearance, defaults. Changes apply immediately —
            no restart required.
          </p>
        </div>
        <div className="page-header__actions">
          <button type="button" className="btn btn--ghost" onClick={() => void disconnect()}>Disconnect</button>
        </div>
      </header>

      {error && <div className="auth-error">{error}</div>}

      <div className="settings-grid">
        <aside className="settings-nav">
          <a href="#org">Organisation</a>
          <a href="#backend">Backend</a>
          <a href="#appearance">Appearance</a>
          <a href="#defaults">Defaults</a>
        </aside>

        <section className="settings-panes">
          <article id="org" className="settings-pane">
            <h2>Organisation</h2>
            <dl className="kv">
              <div><dt>Operator</dt><dd>{account?.name ?? "—"}</dd></div>
              <div><dt>Organisation</dt><dd>{account?.org?.name ?? "—"}</dd></div>
              <div><dt>Org ID</dt><dd className="mono">{account?.org?.id ?? "—"}</dd></div>
            </dl>
          </article>

          <article id="backend" className="settings-pane">
            <h2>Backend</h2>
            <div className="field">
              <label htmlFor="apibase">API base</label>
              <input
                id="apibase"
                value={apiBase}
                onChange={(e) => setApiBase(e.target.value)}
                placeholder="http://localhost:8080"
              />
              <span className="field-hint">Point at staging or a custom deployment.</span>
            </div>
          </article>

          <article id="appearance" className="settings-pane">
            <h2>Appearance</h2>
            <div className="theme-picker">
              {(["dark", "light", "ivory"] as const).map((t) => (
                <button
                  key={t}
                  type="button"
                  className={`theme-pick${prefs.theme === t ? " is-active" : ""}`}
                  onClick={() => applyTheme(t)}
                >
                  <span className={`theme-pick__swatch theme-pick__swatch--${t}`} />
                  <span className="theme-pick__label">{t}</span>
                </button>
              ))}
            </div>
          </article>

          <article id="defaults" className="settings-pane">
            <h2>Defaults</h2>
            <div className="field">
              <label htmlFor="region">Default region</label>
              <select
                id="region"
                value={prefs.defaultRegion ?? "asia-northeast"}
                onChange={(e) => setPrefs((p) => ({ ...p, defaultRegion: e.target.value }))}
              >
                <option value="asia-northeast">Asia · Northeast</option>
                <option value="americas-east">Americas · East</option>
                <option value="europe-west">Europe · West</option>
                <option value="global">Global pool</option>
              </select>
            </div>
            <label className="cluster">
              <input
                type="checkbox"
                checked={Boolean(prefs.notifications)}
                onChange={(e) => setPrefs((p) => ({ ...p, notifications: e.target.checked }))}
              />
              Notify me when jobs finish or fail
            </label>
          </article>

          <div className="settings-foot">
            {savedAt && <span className="mute mono">Saved {new Date(savedAt).toLocaleTimeString()}</span>}
            <button type="button" className="btn btn--primary" onClick={() => void save()} disabled={saving}>
              {saving ? "Saving…" : "Save changes"}
            </button>
          </div>
        </section>
      </div>
    </main>
  );
}
