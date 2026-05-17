/* -------------------------------------------------------------------------
 * Enterprise login — same Electric-Editorial split-pane as the consumer,
 * but the right side asks for an API key instead of email/password and the
 * left hero is more "B2B compute marketplace" tone.
 * ------------------------------------------------------------------------- */

import { FormEvent, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { ArrowRight, Loader2 } from "lucide-react";
import { useAuth } from "../state/auth";
import { bridge } from "../api/bridge";

export function Login() {
  const { connect, error, loading } = useAuth();
  const nav = useNavigate();
  const [apiBase, setApiBase] = useState("http://localhost:8080");
  const [apiKey, setApiKey] = useState("");

  useEffect(() => {
    void (async () => {
      const cfg = await bridge.config.get();
      const stored = (cfg as { apiBase: string }).apiBase;
      if (stored) setApiBase(stored);
    })();
  }, []);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    const ok = await connect(apiBase, apiKey.trim());
    if (ok) nav("/", { replace: true });
  }

  return (
    <div className="min-h-full grid lg:grid-cols-[1.1fr_1fr] bg-[var(--bg-page)]">
      <Hero />
      <section className="flex items-center justify-center px-6 sm:px-12 py-12 lg:py-0 relative">
        <div className="absolute top-6 right-6 lg:top-10 lg:right-10 text-2xs uppercase tracking-micro text-[var(--ink-muted)]">
          enterprise · v0.2
        </div>

        <div className="w-full max-w-[440px] animate-fade-up">
          <div className="mb-8">
            <h1 className="em-h-display mb-2">Connect tenant</h1>
            <p className="text-sm text-[var(--ink-secondary)]">
              Paste an enterprise API key to start submitting jobs to the
              conet marketplace.
            </p>
          </div>

          <form onSubmit={onSubmit} className="space-y-4">
            <Field label="API base URL">
              <input
                className="em-input"
                value={apiBase}
                onChange={(e) => setApiBase(e.target.value)}
                placeholder="https://api.electromesh.io"
              />
            </Field>

            <Field
              label="Enterprise API key"
              hint={<span className="text-2xs uppercase tracking-micro text-[var(--ink-muted)]">starts with em_live_</span>}
            >
              <input
                className="em-input font-mono"
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                placeholder="em_live_…"
                spellCheck={false}
              />
            </Field>

            <p className="text-xs text-[var(--ink-secondary)] leading-relaxed">
              Don't have one yet? Have a tenant admin run{" "}
              <code className="bg-[var(--bg-elev)] px-1.5 py-0.5 rounded text-[11px]">
                POST /v1/enterprise/me/api-keys
              </code>{" "}
              or contact{" "}
              <a className="em-link">support@electromesh.io</a>.
            </p>

            {error && (
              <div className="text-xs leading-relaxed bg-danger-500/8 border border-danger-500/25 text-danger-600 rounded-md px-3 py-2.5">
                {error}
              </div>
            )}

            <button
              type="submit"
              disabled={loading || !apiKey.trim()}
              className="em-btn-primary w-full h-11"
            >
              {loading ? (
                <>
                  <Loader2 className="w-4 h-4 animate-spin" /> Connecting
                </>
              ) : (
                <>
                  Connect tenant <ArrowRight className="w-4 h-4" />
                </>
              )}
            </button>
          </form>

          <div className="mt-12 text-2xs uppercase tracking-micro text-[var(--ink-muted)] text-center">
            All calls are signed · audit log retained for 365 days · soc-2 type II
          </div>
        </div>
      </section>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────
function Hero() {
  return (
    <aside className="hidden lg:flex flex-col justify-between bg-[var(--ink-primary)] text-[var(--bg-surface)] px-12 py-14 relative overflow-hidden">
      <div className="flex items-center gap-2.5 z-10">
        <Mark className="w-7 h-7 text-[var(--electric)]" />
        <div>
          <div className="font-display font-semibold tracking-tight text-[15px]">
            Electro<span className="text-[var(--electric)]">Mesh</span>
          </div>
          <div className="text-2xs uppercase tracking-micro opacity-60">
            Compute · Enterprise
          </div>
        </div>
      </div>

      <div className="z-10 space-y-6 max-w-md">
        <div className="text-2xs uppercase tracking-micro text-[var(--electric)]">
          ▌ Buy compute by the workunit
        </div>
        <h2 className="text-[44px] leading-[1.05] tracking-tightest font-display font-semibold">
          Pay only when consensus <span className="text-[var(--electric)]">passes</span>.
        </h2>
        <p className="text-[15px] leading-relaxed opacity-80 max-w-sm">
          Submit hashcrack, ML-inference, or render jobs to a global mesh of
          16,000+ nodes. We route to the cheapest cluster that meets your
          latency, region, and hardware constraints — and refuse to charge you
          if the quorum fails.
        </p>

        <div className="grid grid-cols-3 gap-6 pt-6 border-t border-white/10 max-w-sm">
          <Stat label="Median floor" value="$0.42" suffix="/h" />
          <Stat label="P50 latency" value="220ms" />
          <Stat label="Regions" value="34" />
        </div>
      </div>

      {/* diagonal grain texture */}
      <div
        className="absolute inset-0 z-0 pointer-events-none opacity-[0.10]"
        style={{
          backgroundImage:
            "repeating-linear-gradient(135deg, currentColor 0px, currentColor 1px, transparent 1px, transparent 14px)"
        }}
      />

      <div className="z-10 flex items-center gap-3 text-2xs uppercase tracking-micro opacity-50">
        <span className="em-dot bg-[var(--electric)] em-dot-pulse" />
        soc-2 type II · cure53 audit · 99.95% SLA
      </div>
    </aside>
  );
}

function Field({ label, hint, children }: { label: string; hint?: React.ReactNode; children: React.ReactNode }) {
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

function Stat({ label, value, suffix }: { label: string; value: string; suffix?: string }) {
  return (
    <div>
      <div className="text-3xl font-semibold tabular tracking-tight">
        {value}
        {suffix && <span className="text-base text-[var(--electric)] ml-0.5">{suffix}</span>}
      </div>
      <div className="text-2xs uppercase tracking-micro mt-1.5 opacity-50">{label}</div>
    </div>
  );
}

function Mark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 32 32" className={className} fill="none" stroke="currentColor" strokeWidth="2"
         strokeLinecap="square" strokeLinejoin="miter">
      <rect x="2" y="2" width="28" height="28" rx="3" />
      <line x1="11" y1="2" x2="11" y2="30" opacity="0.25" />
      <line x1="21" y1="2" x2="21" y2="30" opacity="0.25" />
      <line x1="2" y1="11" x2="30" y2="11" opacity="0.25" />
      <line x1="2" y1="21" x2="30" y2="21" opacity="0.25" />
      <path d="M19 4 L9 18 H15 L13 28 L23 14 H17 Z" fill="currentColor" stroke="none" />
    </svg>
  );
}
