import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useAuth } from "../state/auth";

export function Login() {
  const { login, oauth, loading, error, clearError } = useAuth();
  const nav = useNavigate();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [oauthBusy, setOauthBusy] = useState<"google" | "apple" | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    clearError();
    try {
      await login(email.trim(), password);
      nav("/", { replace: true });
    } catch {
      /* error already in state */
    }
  }

  async function oauthClick(provider: "google" | "apple") {
    setOauthBusy(provider);
    clearError();
    try {
      await oauth(provider);
      nav("/", { replace: true });
    } catch {
      /* error in state */
    } finally {
      setOauthBusy(null);
    }
  }

  return (
    <div className="auth-stage">
      <div className="auth-stage__brand">
        <span className="brand__mark">E</span>
        <span className="brand__wordmark">ELECTROMESH</span>
      </div>

      <section className="auth-card" data-fade>
        <header className="auth-card__header">
          <span className="auth-card__step">Sign in · Personal console</span>
          <h1 className="auth-card__title">Welcome back.</h1>
          <p className="auth-card__lede">
            Pick up where you left off — your devices, earnings and payouts are
            waiting on the other side.
          </p>
        </header>

        <form className="auth-form" onSubmit={submit}>
          <div className="auth-form__row">
            <label htmlFor="email">Email</label>
            <input
              id="email"
              type="email"
              autoComplete="email"
              spellCheck={false}
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@domain.com"
            />
          </div>
          <div className="auth-form__row">
            <label htmlFor="password">Password</label>
            <input
              id="password"
              type="password"
              autoComplete="current-password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="••••••••"
            />
          </div>

          {error && <div className="auth-error">{error}</div>}

          <button type="submit" className="auth-submit" disabled={loading}>
            {loading ? "Signing in…" : "Sign in"}
          </button>

          <div className="auth-divider"><span>or continue with</span></div>

          <div className="auth-oauth">
            <button
              type="button"
              className="oauth-btn"
              disabled={Boolean(oauthBusy)}
              onClick={() => void oauthClick("google")}
            >
              <span className="glyph" aria-hidden>G</span>
              {oauthBusy === "google" ? "Connecting…" : "Google"}
            </button>
            <button
              type="button"
              className="oauth-btn"
              disabled={Boolean(oauthBusy)}
              onClick={() => void oauthClick("apple")}
            >
              <span className="glyph" aria-hidden></span>
              {oauthBusy === "apple" ? "Connecting…" : "Apple"}
            </button>
          </div>
        </form>

        <p className="auth-foot">
          New to ElectroMesh? <Link to="/register">Create an account</Link>
        </p>
      </section>

      <footer className="auth-stage__legal">
        © ElectroMesh — Distributed compute, fairly compensated.
      </footer>
    </div>
  );
}
