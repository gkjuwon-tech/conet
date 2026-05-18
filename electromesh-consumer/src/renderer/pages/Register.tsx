import { useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useAuth } from "../state/auth";

interface PwChecks {
  length: boolean;
  upper: boolean;
  digit: boolean;
  symbol: boolean;
}

function pwChecks(password: string): PwChecks {
  return {
    length: password.length >= 10,
    upper: /[A-Z]/.test(password),
    digit: /\d/.test(password),
    symbol: /[^A-Za-z0-9]/.test(password)
  };
}

export function Register() {
  const { register, loading, error, clearError } = useAuth();
  const nav = useNavigate();
  const [email, setEmail] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [country, setCountry] = useState("KR");
  const [password, setPassword] = useState("");
  const checks = useMemo(() => pwChecks(password), [password]);
  const valid =
    email && password && checks.length && checks.upper && checks.digit;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    clearError();
    if (!valid) return;
    try {
      await register({
        email: email.trim(),
        password,
        display_name: displayName.trim() || undefined,
        country_code: country
      });
      nav("/", { replace: true });
    } catch {
      /* error in state */
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
          <span className="auth-card__step">Create your account</span>
          <h1 className="auth-card__title">Get on the mesh.</h1>
          <p className="auth-card__lede">
            One account ties together every device you lend. Earnings settle to
            this account, and only you can decommission them.
          </p>
        </header>

        <form className="auth-form" onSubmit={submit}>
          <div className="auth-form__row">
            <label htmlFor="email">Email</label>
            <input
              id="email"
              type="email"
              required
              autoComplete="email"
              spellCheck={false}
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@domain.com"
            />
          </div>

          <div className="auth-form__row">
            <label htmlFor="display">Display name</label>
            <input
              id="display"
              type="text"
              autoComplete="nickname"
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              placeholder="Optional — defaults to your email"
            />
          </div>

          <div className="auth-form__row">
            <label htmlFor="country">Country</label>
            <select
              id="country"
              value={country}
              onChange={(e) => setCountry(e.target.value)}
            >
              <option value="KR">South Korea (KR)</option>
              <option value="US">United States (US)</option>
              <option value="JP">Japan (JP)</option>
              <option value="DE">Germany (DE)</option>
              <option value="GB">United Kingdom (GB)</option>
              <option value="OTHER">Other</option>
            </select>
          </div>

          <div className="auth-form__row">
            <label htmlFor="password">Password</label>
            <input
              id="password"
              type="password"
              autoComplete="new-password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="At least 10 characters, mix of case + numbers"
            />
            <div className="pw-checks">
              {[
                { key: "length", label: "10+ characters", ok: checks.length },
                { key: "upper", label: "Mixed case", ok: checks.upper },
                { key: "digit", label: "Contains digit", ok: checks.digit },
                { key: "symbol", label: "Symbol (optional)", ok: checks.symbol }
              ].map((c) => (
                <span key={c.key} className={`pw-check${c.ok ? " is-ok" : ""}`}>
                  <span className="pw-check__dot" /> {c.label}
                </span>
              ))}
            </div>
          </div>

          {error && <div className="auth-error">{error}</div>}

          <button type="submit" className="auth-submit" disabled={loading || !valid}>
            {loading ? "Creating account…" : "Create account"}
          </button>
        </form>

        <p className="auth-foot">
          Already on the mesh? <Link to="/login">Sign in instead</Link>
        </p>
      </section>

      <footer className="auth-stage__legal">
        © ElectroMesh — By continuing you accept the terms of service.
      </footer>
    </div>
  );
}
