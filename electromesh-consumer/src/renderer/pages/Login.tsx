/* -------------------------------------------------------------------------
 * Login — split-pane editorial design.
 *
 * Left: marketing hero — kinetic ASCII grid + tagline + 3 stats.
 * Right: form with OAuth (Google + Apple) above the email/password fold.
 *
 * The OAuth buttons go through `window.electromesh.auth.oauth(provider)`
 * which the main process handles by:
 *   1. POST /v1/users/oauth/{provider}/start  (gets the authorize URL)
 *   2. opens a child window pointing at that URL
 *   3. captures the callback redirect, exchanges code → JWT
 *   4. resolves the IPC promise with the same shape as a normal login
 *
 * If the backend isn't configured for that provider yet (dev mode), the
 * button shows a "coming soon" toast instead of failing silently.
 * ------------------------------------------------------------------------- */

import { FormEvent, useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { ArrowRight, Loader2 } from "lucide-react";
import { useAuth } from "../state/auth";
import { ElectroMark } from "../components/Brand";

type OAuthProvider = "google" | "apple";

interface AuthBridge {
  oauth?: (
    provider: OAuthProvider
  ) => Promise<{ ok: boolean; error?: string; user?: unknown }>;
}

export function Login() {
  const { login, error, loading } = useAuth();
  const nav = useNavigate();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [oauthBusy, setOauthBusy] = useState<OAuthProvider | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    const ok = await login(email, password);
    if (ok) nav("/", { replace: true });
  }

  async function onOauth(provider: OAuthProvider) {
    setToast(null);
    setOauthBusy(provider);
    const auth = (window.electromesh as unknown as { auth: AuthBridge }).auth;
    try {
      if (!auth.oauth) {
        setToast(
          "Update the desktop app — your build doesn't yet support OAuth handoff."
        );
        return;
      }
      const res = await auth.oauth(provider);
      if (!res.ok) {
        setToast(res.error ?? `${provider} sign-in cancelled`);
        return;
      }
      nav("/", { replace: true });
    } finally {
      setOauthBusy(null);
    }
  }

  return (
    <div className="min-h-full grid lg:grid-cols-[1.1fr_1fr] bg-[var(--bg-page)]">
      <Hero />
      <section className="flex items-center justify-center px-6 sm:px-12 py-12 lg:py-0 relative">
        <div className="absolute top-6 right-6 lg:top-10 lg:right-10 text-2xs uppercase tracking-micro text-[var(--ink-muted)]">
          v0.2 · build {(import.meta as { env?: { MODE?: string } }).env?.MODE ?? "dev"}
        </div>

        <div className="w-full max-w-[420px] animate-fade-up">
          <div className="lg:hidden mb-8 flex items-center gap-2">
            <ElectroMark className="w-7 h-7" />
            <span className="font-mono font-medium tracking-tight">conet</span>
          </div>

          <div className="mb-8">
            <h1 className="em-h-display mb-2">Sign in</h1>
            <p className="text-sm text-[var(--ink-secondary)]">
              Lease your devices — earn while they idle.
            </p>
          </div>

          {/* OAuth row */}
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
            <Field label="Email">
              <input
                type="email"
                required
                autoFocus
                className="em-input"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="alex@example.com"
              />
            </Field>

            <Field
              label="Password"
              hint={
                <Link
                  to="/register"
                  className="text-2xs uppercase tracking-micro text-[var(--ink-muted)] hover:text-[var(--ink-primary)]"
                >
                  Forgot?
                </Link>
              }
            >
              <input
                type="password"
                required
                className="em-input"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
            </Field>

            {(error || toast) && (
              <div className="text-xs leading-relaxed bg-danger-500/8 border border-danger-500/25 text-danger-600 rounded-md px-3 py-2.5">
                {toast ?? error}
              </div>
            )}

            <button
              type="submit"
              disabled={loading || !email || !password}
              className="em-btn-primary w-full h-11"
            >
              {loading ? (
                <>
                  <Loader2 className="w-4 h-4 animate-spin" /> Signing in
                </>
              ) : (
                <>
                  Continue <ArrowRight className="w-4 h-4" />
                </>
              )}
            </button>
          </form>

          <div className="mt-8 text-center text-sm text-[var(--ink-secondary)]">
            New to conet?{" "}
            <Link to="/register" className="em-link">
              Create an account
            </Link>
          </div>

          <div className="mt-12 text-2xs uppercase tracking-micro text-[var(--ink-muted)] text-center">
            By continuing, you agree to our terms · audit log retained for 90 days.
          </div>
        </div>
      </section>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────
// Hero (left pane). Designed, not generic.
// ─────────────────────────────────────────────────────────────────────────
function Hero() {
  // Animate the kinetic grid — pulse a few "live" dots.
  const [pulse, setPulse] = useState<Set<number>>(new Set());
  useEffect(() => {
    const id = setInterval(() => {
      setPulse(() => {
        const out = new Set<number>();
        for (let i = 0; i < 8; i++) out.add(Math.floor(Math.random() * 14 * 24));
        return out;
      });
    }, 1300);
    return () => clearInterval(id);
  }, []);

  return (
    <aside className="hidden lg:flex flex-col justify-between bg-[var(--ink-primary)] text-[var(--bg-surface)] px-12 py-14 relative overflow-hidden">
      {/* Wordmark */}
      <div className="flex items-center gap-2.5 z-10">
        <ElectroMark className="w-8 h-8 text-[var(--electric)]" />
        <div>
          <div className="font-display font-semibold tracking-tight text-[15px]">
            conet
          </div>
          <div className="text-2xs uppercase tracking-micro opacity-60">
            Compute · Distributed
          </div>
        </div>
      </div>

      {/* Hero copy */}
      <div className="z-10 space-y-6 max-w-md">
        <div className="text-2xs uppercase tracking-micro text-[var(--electric)]">
          ▌ For homes that already pay the power bill
        </div>
        <h2 className="text-[44px] leading-[1.05] tracking-tightest font-display font-semibold">
          Every plugged-in <span className="text-[var(--electric)]">device</span> is a tiny GPU.
        </h2>
        <p className="text-[15px] leading-relaxed opacity-80 max-w-sm">
          Your phone, fridge, router, even the lightbulb — when they sit idle,
          conet turns their wasted cycles into measurable earnings. Pair
          one device today; pair sixteen by the weekend.
        </p>

        <div className="grid grid-cols-3 gap-6 pt-6 border-t border-white/10 max-w-sm">
          <Stat label="Device classes" value="16" />
          <Stat label="Avg. ROI" value="0.8/W" suffix="·d" />
          <Stat label="LAN claims" value="OTP-locked" small />
        </div>
      </div>

      {/* Kinetic dot grid */}
      <div className="absolute inset-0 z-0 pointer-events-none opacity-[0.18]">
        <div
          className="absolute inset-0"
          style={{
            backgroundImage:
              "radial-gradient(circle at center, rgba(182,255,26,0.6) 1.2px, transparent 1.6px)",
            backgroundSize: "26px 26px",
          }}
        />
        <DotMatrix pulse={pulse} />
      </div>

      {/* Bottom-left meta */}
      <div className="z-10 flex items-center gap-3 text-2xs uppercase tracking-micro opacity-50">
        <span className="em-dot bg-[var(--electric)] em-dot-pulse" />
        Tokio · Berlin · São Paulo · Seoul · 16,212 nodes online
      </div>
    </aside>
  );
}

function Stat({
  label,
  value,
  suffix,
  small
}: {
  label: string;
  value: string;
  suffix?: string;
  small?: boolean;
}) {
  return (
    <div>
      <div className={small ? "text-base font-semibold tracking-tight" : "text-3xl font-semibold tabular tracking-tight"}>
        {value}
        {suffix && <span className="text-base text-[var(--electric)] ml-0.5">{suffix}</span>}
      </div>
      <div className="text-2xs uppercase tracking-micro mt-1.5 opacity-50">{label}</div>
    </div>
  );
}

function DotMatrix({ pulse }: { pulse: Set<number> }) {
  const cols = 24;
  const rows = 14;
  const cells: number[] = [];
  for (let i = 0; i < cols * rows; i++) cells.push(i);
  return (
    <svg className="absolute right-[-60px] bottom-[-40px] w-[900px] h-[520px]" viewBox={`0 0 ${cols * 26} ${rows * 26}`}>
      {cells.map((i) => {
        const x = (i % cols) * 26 + 13;
        const y = Math.floor(i / cols) * 26 + 13;
        const isPulsed = pulse.has(i);
        return (
          <circle
            key={i}
            cx={x}
            cy={y}
            r={isPulsed ? 3.4 : 1.2}
            fill={isPulsed ? "var(--signal)" : "currentColor"}
            opacity={isPulsed ? 0.85 : 0.20}
            className="transition-all duration-700 ease-[cubic-bezier(0.16,1,0.3,1)]"
          />
        );
      })}
    </svg>
  );
}

// ─────────────────────────────────────────────────────────────────────────
// Form helpers
// ─────────────────────────────────────────────────────────────────────────
function Field({
  label,
  hint,
  children
}: {
  label: string;
  hint?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div>
      <div className="flex items-center justify-between mb-1.5">
        <span className="em-label mb-0">{label}</span>
        {hint}
      </div>
      {children}
    </div>
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
    google: "Google",
    apple: "Apple"
  };
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="em-btn-soft h-11 text-[13px] font-medium relative overflow-hidden"
    >
      {busy ? (
        <Loader2 className="w-4 h-4 animate-spin" />
      ) : provider === "google" ? (
        <GoogleIcon />
      ) : (
        <AppleIcon />
      )}
      {labels[provider]}
    </button>
  );
}

function GoogleIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 18 18" aria-hidden>
      <path d="M17.64 9.2c0-.64-.06-1.25-.16-1.84H9v3.48h4.84c-.21 1.13-.84 2.09-1.79 2.73v2.27h2.9c1.7-1.56 2.69-3.87 2.69-6.64z" fill="#4285F4"/>
      <path d="M9 18c2.43 0 4.47-.81 5.96-2.18l-2.9-2.27c-.81.55-1.84.86-3.06.86-2.34 0-4.32-1.58-5.03-3.71H.97v2.34A8.997 8.997 0 0 0 9 18z" fill="#34A853"/>
      <path d="M3.97 10.71A5.41 5.41 0 0 1 3.68 9c0-.59.1-1.16.28-1.71V4.95H.97A8.997 8.997 0 0 0 0 9c0 1.45.35 2.83.97 4.05l3-2.34z" fill="#FBBC05"/>
      <path d="M9 3.58c1.32 0 2.5.45 3.44 1.35l2.58-2.58C13.46.89 11.43 0 9 0A8.997 8.997 0 0 0 .97 4.95l3 2.34C4.68 5.16 6.66 3.58 9 3.58z" fill="#EA4335"/>
    </svg>
  );
}

function AppleIcon() {
  return (
    <svg width="14" height="16" viewBox="0 0 14 16" fill="currentColor" aria-hidden>
      <path d="M11.182.008C11.148-.03 9.923.023 8.857 1.18c-1.066 1.156-.902 2.482-.878 2.516.024.034 1.52.087 2.475-1.258.955-1.346.762-2.391.728-2.43zm3.314 11.733c-.048-.096-2.325-1.234-2.113-3.422.212-2.189 1.675-2.789 1.698-2.854.023-.065-.597-.79-1.254-1.157a3.692 3.692 0 0 0-1.563-.434c-.108-.003-.483-.095-1.254.116-.508.139-1.653.589-1.968.607-.316.018-1.256-.522-2.267-.665-.647-.125-1.333.131-1.824.328-.49.196-1.422.754-2.074 2.237-.652 1.482-.311 3.83-.067 4.56.244.729.625 1.924 1.273 2.796.576.984 1.34 1.667 1.659 1.899.319.232 1.219.386 1.843.067.502-.308 1.408-.485 1.766-.472.357.013 1.061.154 1.782.539.571.197 1.111.115 1.652-.105.541-.221 1.324-1.059 2.238-2.758.347-.79.505-1.217.473-1.282z"/>
    </svg>
  );
}
