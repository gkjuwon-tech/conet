import { useEffect, useState } from "react";
import { useAuth } from "../state/auth";
import { bridge } from "../api/bridge";

interface Prefs {
  theme?: "dark" | "light";
  autostart?: boolean;
  notifications?: boolean;
  payoutCurrency?: string;
}

export function Settings() {
  const { user, logout } = useAuth();
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

  function applyTheme(t: "dark" | "light") {
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
          <h1 className="page-header__title">Console preferences</h1>
          <p className="page-header__lede">
            Backend endpoint, appearance, notifications. Changes apply
            immediately — no restart required.
          </p>
        </div>
        <div className="page-header__actions">
          <button type="button" className="btn btn--ghost" onClick={() => void logout()}>Sign out</button>
        </div>
      </header>

      {error && <div className="auth-error">{error}</div>}

      <div className="settings-grid">
        <aside className="settings-nav">
          <a href="#identity">Identity</a>
          <a href="#backend">Backend</a>
          <a href="#appearance">Appearance</a>
          <a href="#agent">Agent</a>
          <a href="#wallet">Wallet</a>
        </aside>

        <section className="settings-panes">
          <article id="identity" className="settings-pane">
            <h2>Identity</h2>
            <dl className="kv">
              <div><dt>Email</dt><dd>{user?.email ?? "—"}</dd></div>
              <div><dt>Display name</dt><dd>{user?.display_name ?? "—"}</dd></div>
              <div><dt>Country</dt><dd>{user?.country_code ?? "—"}</dd></div>
              <div><dt>User ID</dt><dd className="mono">{user?.id ?? "—"}</dd></div>
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
              <span className="field-hint">
                Change this to point the consumer at staging or a remote
                deployment. Takes effect on the next request.
              </span>
            </div>
          </article>

          <article id="appearance" className="settings-pane">
            <h2>Appearance</h2>
            <div className="theme-picker">
              {(["dark", "light"] as const).map((t) => (
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

          <article id="agent" className="settings-pane">
            <h2>Agent</h2>
            <label className="cluster">
              <input
                type="checkbox"
                checked={Boolean(prefs.autostart)}
                onChange={(e) => setPrefs((p) => ({ ...p, autostart: e.target.checked }))}
              />
              Start the agent automatically on launch
            </label>
            <label className="cluster">
              <input
                type="checkbox"
                checked={Boolean(prefs.notifications)}
                onChange={(e) => setPrefs((p) => ({ ...p, notifications: e.target.checked }))}
              />
              Show notifications when payouts settle or devices go offline
            </label>
          </article>

          <article id="wallet" className="settings-pane">
            <h2>Wallet</h2>
            <div className="field">
              <label htmlFor="currency">Payout currency</label>
              <select
                id="currency"
                value={prefs.payoutCurrency ?? "USD"}
                onChange={(e) => setPrefs((p) => ({ ...p, payoutCurrency: e.target.value }))}
              >
                <option value="USD">USD</option>
                <option value="KRW">KRW</option>
                <option value="JPY">JPY</option>
                <option value="EUR">EUR</option>
              </select>
              <span className="field-hint">Display currency for the dashboard.</span>
            </div>
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
