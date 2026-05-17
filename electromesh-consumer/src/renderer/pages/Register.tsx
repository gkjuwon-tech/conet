/* -------------------------------------------------------------------------
 * Register — same split-pane shell as Login but the right pane is wider
 * (form is bigger) and the hero copy is more "step zero" tone.
 * ------------------------------------------------------------------------- */

import { FormEvent, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { ArrowRight, Check, Loader2, X } from "lucide-react";
import { useAuth } from "../state/auth";
import { ElectroMark, ElectroWordmark } from "../components/Brand";

type OAuthProvider = "google" | "apple";

interface AuthBridge {
  oauth?: (
    provider: OAuthProvider
  ) => Promise<{ ok: boolean; error?: string }>;
}

export function Register() {
  const { register, error, loading } = useAuth();
  const nav = useNavigate();

  const [email, setEmail] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [country, setCountry] = useState("");
  const [accepted, setAccepted] = useState(false);
  const [oauthBusy, setOauthBusy] = useState<OAuthProvider | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  // Live password rules — gives the user a nice progressive reveal.
  const rules = [
    { ok: password.length >= 10, label: "10 characters or more" },
    { ok: /[A-Z]/.test(password), label: "One uppercase letter" },
    { ok: /[a-z]/.test(password), label: "One lowercase letter" },
    { ok: /\d/.test(password), label: "One number" },
    { ok: confirm.length > 0 && password === confirm, label: "Passwords match" }
  ];

  const valid =
    email.includes("@") &&
    rules.every((r) => r.ok) &&
    accepted;

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (!valid) return;
    const ok = await register({
      email,
      password,
      display_name: displayName || undefined,
      country_code: country || undefined
    });
    if (ok) nav("/onboarding", { replace: true });
  }

  async function onOauth(provider: OAuthProvider) {
    setToast(null);
    setOauthBusy(provider);
    const auth = (window.electromesh as unknown as { auth: AuthBridge }).auth;
    try {
      if (!auth.oauth) {
        setToast("Update the desktop app to use OAuth sign-up.");
        return;
      }
      const res = await auth.oauth(provider);
      if (!res.ok) {
        setToast(res.error ?? `${provider} sign-up cancelled`);
        return;
      }
      nav("/onboarding", { replace: true });
    } finally {
      setOauthBusy(null);
    }
  }

  return (
    <div className="min-h-full grid lg:grid-cols-[1fr_1.4fr] bg-[var(--bg-page)]">
      {/* LEFT — short brand strip, not the giant hero used on Login */}
      <aside className="hidden lg:flex flex-col justify-between bg-[var(--ink-primary)] text-[var(--bg-surface)] px-12 py-14 relative overflow-hidden">
        <div className="flex items-center gap-2.5 z-10">
          <ElectroMark className="w-7 h-7 text-[var(--electric)]" />
          <ElectroWordmark className="text-[15px]" />
        </div>

        <div className="z-10 space-y-8 max-w-sm">
          <div className="text-2xs uppercase tracking-micro text-[var(--electric)]">
            ▌ Step 1 of 3 — Create your account
          </div>
          <h2 className="text-[36px] leading-[1.1] tracking-tightest font-display font-semibold">
            Three minutes from <em className="not-italic text-[var(--electric)]">zero</em> to first earnings.
          </h2>

          <ol className="space-y-5 mt-8 max-w-xs">
            <Step n="01" title="Sign up" hint="OAuth or email — your choice." done />
            <Step n="02" title="Pair one device" hint="Most users start with their phone." />
            <Step n="03" title="Idle = earning" hint="The agent does the rest." />
          </ol>
        </div>

        <div className="z-10 text-2xs uppercase tracking-micro opacity-50">
          Audited by <span className="text-[var(--electric)]">cure53</span> · 2025
        </div>

        {/* tiny diagonal grid texture */}
        <div
          className="absolute inset-0 z-0 pointer-events-none opacity-[0.10]"
          style={{
            backgroundImage:
              "repeating-linear-gradient(135deg, currentColor 0px, currentColor 1px, transparent 1px, transparent 14px)"
          }}
        />
      </aside>

      {/* RIGHT — form */}
      <section className="flex items-center justify-center px-6 sm:px-12 py-12 lg:py-14 relative">
        <div className="w-full max-w-[520px] animate-fade-up">
          <div className="lg:hidden mb-8 flex items-center gap-2">
            <ElectroMark className="w-7 h-7" />
            <ElectroWordmark />
          </div>

          <h1 className="em-h-display mb-2">Create account</h1>
          <p className="text-sm text-[var(--ink-secondary)] mb-7">
            Lend a fraction of your devices' idle time. Cancel any device at any
            time — there's no contract.
          </p>

          {/* OAuth */}
          <div className="grid grid-cols-2 gap-2 mb-2">
            <OAuthButton
              provider="google"
              busy={oauthBusy === "google"}
              disabled={!!oauthBusy || loading}
              onClick={() => void onOauth("google")}
            />
            <OAuthButton
              provider="apple"
              busy={oauthBusy === "apple"}
              disabled={!!oauthBusy || loading}
              onClick={() => void onOauth("apple")}
            />
          </div>

          <div className="em-divider"><span>or with email</span></div>

          <form onSubmit={onSubmit} className="space-y-4">
            <div className="grid grid-cols-2 gap-3">
              <FieldFull label="Email">
                <input
                  type="email"
                  required
                  autoFocus
                  className="em-input"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="alex@example.com"
                />
              </FieldFull>

              <FieldFull label="Display name (optional)">
                <input
                  className="em-input"
                  value={displayName}
                  onChange={(e) => setDisplayName(e.target.value)}
                  placeholder="alex"
                />
              </FieldFull>

              <FieldFull label="Password">
                <input
                  type="password"
                  required
                  className="em-input"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                />
              </FieldFull>

              <FieldFull label="Confirm">
                <input
                  type="password"
                  required
                  className="em-input"
                  value={confirm}
                  onChange={(e) => setConfirm(e.target.value)}
                />
              </FieldFull>

              <div className="col-span-2">
                <FieldFull label="Country (ISO-2, optional)">
                  <input
                    maxLength={2}
                    className="em-input uppercase tracking-widest text-center max-w-[120px]"
                    value={country}
                    onChange={(e) => setCountry(e.target.value.toUpperCase())}
                    placeholder="DE"
                  />
                </FieldFull>
              </div>
            </div>

            {/* Password rules */}
            {(password || confirm) && (
              <div className="grid grid-cols-2 gap-x-4 gap-y-1.5 text-xs">
                {rules.map((r) => (
                  <div
                    key={r.label}
                    className={`flex items-center gap-1.5 ${
                      r.ok ? "text-[var(--ok-500,#10b981)]" : "text-[var(--ink-muted)]"
                    }`}
                  >
                    {r.ok ? (
                      <Check className="w-3 h-3" />
                    ) : (
                      <X className="w-3 h-3 opacity-60" />
                    )}
                    {r.label}
                  </div>
                ))}
              </div>
            )}

            <label className="flex items-start gap-2.5 text-xs text-[var(--ink-secondary)] leading-relaxed cursor-pointer">
              <input
                type="checkbox"
                className="mt-0.5 accent-[var(--electric)]"
                checked={accepted}
                onChange={(e) => setAccepted(e.target.checked)}
              />
              <span>
                I agree to the{" "}
                <a className="em-link">Terms</a> and consent to my devices running
                background workloads while idle. Devices can be paused or
                decommissioned at any time.
              </span>
            </label>

            {(error || toast) && (
              <div className="text-xs leading-relaxed bg-danger-500/8 border border-danger-500/25 text-danger-600 rounded-md px-3 py-2.5">
                {toast ?? error}
              </div>
            )}

            <button
              type="submit"
              disabled={!valid || loading}
              className="em-btn-primary w-full h-11"
            >
              {loading ? (
                <>
                  <Loader2 className="w-4 h-4 animate-spin" /> Creating account
                </>
              ) : (
                <>
                  Create account <ArrowRight className="w-4 h-4" />
                </>
              )}
            </button>
          </form>

          <div className="mt-8 text-center text-sm text-[var(--ink-secondary)]">
            Already have an account?{" "}
            <Link to="/login" className="em-link">
              Sign in
            </Link>
          </div>
        </div>
      </section>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────
function FieldFull({
  label,
  children
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <label className="em-label">{label}</label>
      {children}
    </div>
  );
}

function Step({
  n,
  title,
  hint,
  done
}: {
  n: string;
  title: string;
  hint: string;
  done?: boolean;
}) {
  return (
    <li className="flex items-start gap-3">
      <span
        className={`w-7 h-7 rounded-md grid place-items-center font-mono text-2xs font-semibold tracking-micro shrink-0 ${
          done
            ? "bg-[var(--electric)] text-[var(--ink-primary)]"
            : "border border-white/15 text-white/70"
        }`}
      >
        {done ? <Check className="w-3.5 h-3.5" strokeWidth={3} /> : n}
      </span>
      <div>
        <div className="text-sm font-medium">{title}</div>
        <div className="text-2xs uppercase tracking-micro opacity-55 mt-0.5">{hint}</div>
      </div>
    </li>
  );
}

function OAuthButton({
  provider,
  busy,
  disabled,
  onClick
}: {
  provider: OAuthProvider;
  busy: boolean;
  disabled: boolean;
  onClick: () => void;
}) {
  const labels: Record<OAuthProvider, string> = {
    google: "Sign up with Google",
    apple: "Sign up with Apple"
  };
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="em-btn-soft h-11 text-[12.5px] font-medium"
    >
      {busy ? (
        <Loader2 className="w-4 h-4 animate-spin" />
      ) : provider === "google" ? (
        <svg width="16" height="16" viewBox="0 0 18 18" aria-hidden>
          <path d="M17.64 9.2c0-.64-.06-1.25-.16-1.84H9v3.48h4.84c-.21 1.13-.84 2.09-1.79 2.73v2.27h2.9c1.7-1.56 2.69-3.87 2.69-6.64z" fill="#4285F4"/>
          <path d="M9 18c2.43 0 4.47-.81 5.96-2.18l-2.9-2.27c-.81.55-1.84.86-3.06.86-2.34 0-4.32-1.58-5.03-3.71H.97v2.34A8.997 8.997 0 0 0 9 18z" fill="#34A853"/>
          <path d="M3.97 10.71A5.41 5.41 0 0 1 3.68 9c0-.59.1-1.16.28-1.71V4.95H.97A8.997 8.997 0 0 0 0 9c0 1.45.35 2.83.97 4.05l3-2.34z" fill="#FBBC05"/>
          <path d="M9 3.58c1.32 0 2.5.45 3.44 1.35l2.58-2.58C13.46.89 11.43 0 9 0A8.997 8.997 0 0 0 .97 4.95l3 2.34C4.68 5.16 6.66 3.58 9 3.58z" fill="#EA4335"/>
        </svg>
      ) : (
        <svg width="14" height="16" viewBox="0 0 14 16" fill="currentColor" aria-hidden>
          <path d="M11.182.008C11.148-.03 9.923.023 8.857 1.18c-1.066 1.156-.902 2.482-.878 2.516.024.034 1.52.087 2.475-1.258.955-1.346.762-2.391.728-2.43zm3.314 11.733c-.048-.096-2.325-1.234-2.113-3.422.212-2.189 1.675-2.789 1.698-2.854.023-.065-.597-.79-1.254-1.157a3.692 3.692 0 0 0-1.563-.434c-.108-.003-.483-.095-1.254.116-.508.139-1.653.589-1.968.607-.316.018-1.256-.522-2.267-.665-.647-.125-1.333.131-1.824.328-.49.196-1.422.754-2.074 2.237-.652 1.482-.311 3.83-.067 4.56.244.729.625 1.924 1.273 2.796.576.984 1.34 1.667 1.659 1.899.319.232 1.219.386 1.843.067.502-.308 1.408-.485 1.766-.472.357.013 1.061.154 1.782.539.571.197 1.111.115 1.652-.105.541-.221 1.324-1.059 2.238-2.758.347-.79.505-1.217.473-1.282z"/>
        </svg>
      )}
      {labels[provider]}
    </button>
  );
}
