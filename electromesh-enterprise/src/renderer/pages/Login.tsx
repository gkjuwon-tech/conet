import { useEffect, useState } from "react";
import { useAuth } from "../state/auth";
import { bridge } from "../api/bridge";

export function Login() {
  const { connect, loading, error, clearError } = useAuth();
  const [apiKey, setApiKey] = useState("");
  const [apiBase, setApiBase] = useState("");
  const [reveal, setReveal] = useState(false);

  useEffect(() => {
    bridge.config.get().then((cfg) => setApiBase(cfg.apiBase)).catch(() => null);
  }, []);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    clearError();
    try {
      await connect(apiKey.trim(), apiBase.trim() || undefined);
    } catch {
      /* error in state */
    }
  }

  return (
    <div className="auth-stage">
      <div className="auth-stage__brand">
        <span className="brand__mark">E</span>
        <span className="brand__wordmark">ELECTROMESH</span>
        <span className="brand__suffix">Operator</span>
      </div>

      <section className="auth-card" data-fade>
        <header className="auth-card__header">
          <span className="auth-card__step">Connect · Operator console</span>
          <h1 className="auth-card__title">Plug in your API key.</h1>
          <p className="auth-card__lede">
            The Operator console runs against your organisation's enterprise
            credentials. Paste an{" "}
            <code>em_live_…</code> key from the Backend dashboard or generate a
            fresh one with{" "}
            <code className="mono">POST /v1/enterprise/api-keys</code>.
          </p>
        </header>

        <form className="auth-form" onSubmit={submit}>
          <div className="auth-form__row">
            <label htmlFor="apibase">Backend</label>
            <input
              id="apibase"
              type="text"
              value={apiBase}
              onChange={(e) => setApiBase(e.target.value)}
              placeholder="http://localhost:8080"
              spellCheck={false}
            />
            <span className="field-hint">Override the API host (e.g. for staging).</span>
          </div>

          <div className="auth-form__row">
            <label htmlFor="apikey">API key</label>
            <div className="input-stack">
              <input
                id="apikey"
                type={reveal ? "text" : "password"}
                required
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                placeholder="em_live_…"
                spellCheck={false}
              />
              <button
                type="button"
                className="btn btn--quiet btn--sm"
                onClick={() => setReveal((r) => !r)}
              >
                {reveal ? "Hide" : "Show"}
              </button>
            </div>
            <span className="field-hint">
              Keys are stored encrypted in this device's keychain — they never
              leave your machine.
            </span>
          </div>

          {error && <div className="auth-error">{error}</div>}

          <button type="submit" className="auth-submit" disabled={loading || !apiKey.trim()}>
            {loading ? "Connecting…" : "Connect"}
          </button>
        </form>

        <p className="auth-foot mono mute">
          Need a key? Backend cookbook: <code>backend/.bootstrap.json</code>
        </p>
      </section>

      <footer className="auth-stage__legal">
        © ElectroMesh — Operator. Bring compute to where the buyers are.
      </footer>
    </div>
  );
}
