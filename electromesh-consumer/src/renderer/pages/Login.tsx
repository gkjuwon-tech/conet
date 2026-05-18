import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useAuth } from "../state/auth";

function GoogleGlyph() {
  // Google's "G" mark, drawn with the official four-color SVG path.
  return (
    <svg className="oauth-glyph" width="18" height="18" viewBox="0 0 18 18" aria-hidden focusable={false}>
      <path d="M17.64 9.2c0-.64-.06-1.25-.17-1.84H9v3.48h4.84a4.14 4.14 0 0 1-1.8 2.71v2.26h2.91c1.7-1.57 2.69-3.88 2.69-6.61z" fill="#4285F4" />
      <path d="M9 18c2.43 0 4.47-.8 5.96-2.18l-2.91-2.26c-.81.54-1.84.86-3.05.86-2.34 0-4.33-1.58-5.04-3.71H.96v2.33A9 9 0 0 0 9 18z" fill="#34A853" />
      <path d="M3.96 10.71A5.41 5.41 0 0 1 3.68 9c0-.59.1-1.17.28-1.71V4.96H.96A9 9 0 0 0 0 9c0 1.45.35 2.83.96 4.04l3-2.33z" fill="#FBBC05" />
      <path d="M9 3.58c1.32 0 2.51.45 3.44 1.35l2.58-2.58C13.46.89 11.43 0 9 0A9 9 0 0 0 .96 4.96l3 2.33C4.67 5.16 6.66 3.58 9 3.58z" fill="#EA4335" />
    </svg>
  );
}

function AppleGlyph() {
  // Apple logo. White on dark, black on light — CSS picks the colour via
  // currentColor so the button can theme itself.
  return (
    <svg className="oauth-glyph" width="16" height="18" viewBox="0 0 16 18" aria-hidden focusable={false}>
      <path
        fill="currentColor"
        d="M13.34 9.55c-.02-2.32 1.9-3.43 1.98-3.49-1.08-1.58-2.76-1.8-3.36-1.82-1.43-.14-2.79.84-3.52.84-.73 0-1.85-.82-3.04-.8-1.56.03-3 .9-3.81 2.3-1.62 2.82-.41 6.99 1.17 9.27.77 1.12 1.69 2.38 2.9 2.33 1.16-.04 1.6-.75 3.01-.75 1.41 0 1.8.75 3.03.72 1.25-.02 2.04-1.14 2.81-2.26.88-1.3 1.24-2.56 1.26-2.63-.03-.01-2.41-.93-2.43-3.71zM10.99 2.78c.64-.78 1.07-1.86.95-2.94-.92.04-2.04.62-2.7 1.39-.59.68-1.11 1.78-.97 2.83 1.03.08 2.08-.52 2.72-1.28z"
      />
    </svg>
  );
}

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
              className="oauth-btn oauth-btn--google"
              disabled={Boolean(oauthBusy)}
              onClick={() => void oauthClick("google")}
              aria-label="Sign in with Google"
            >
              <GoogleGlyph />
              <span className="oauth-btn__label">
                {oauthBusy === "google" ? "Opening Google…" : "Sign in with Google"}
              </span>
            </button>
            <button
              type="button"
              className="oauth-btn oauth-btn--apple"
              disabled={Boolean(oauthBusy)}
              onClick={() => void oauthClick("apple")}
              aria-label="Sign in with Apple"
            >
              <AppleGlyph />
              <span className="oauth-btn__label">
                {oauthBusy === "apple" ? "Opening Apple…" : "Sign in with Apple"}
              </span>
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
