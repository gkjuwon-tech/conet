/* -------------------------------------------------------------------------
 * Onboarding — single-button "claim this Wi-Fi" experience.
 *
 * Old design had a 3-choice picker that forced the user to think about
 * pairing strategies (PC vs LAN vs skip). The product reality is: there's
 * only one correct first action — sweep this Wi-Fi and claim everything.
 * That used to be option B; now it IS the screen.
 *
 * The split-pane editorial DNA from the previous version is preserved on
 * the left. The right pane collapses to one hero CTA plus a tiny
 * "advanced" disclosure that re-exposes the old menu for power users.
 * ------------------------------------------------------------------------- */

import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { Cpu, Plug, Shield, Wallet, Zap, ChevronDown } from "lucide-react";
import { ElectroMark, ElectroWordmark } from "../components/Brand";

export function Onboarding() {
  const nav = useNavigate();
  const [showAdvanced, setShowAdvanced] = useState(false);

  return (
    <div className="min-h-full grid lg:grid-cols-[1fr_1.2fr] bg-[var(--bg-page)]">
      {/* ───── LEFT: dark hero ───── */}
      <aside className="hidden lg:flex flex-col justify-between bg-[var(--ink-primary)] text-[var(--bg-surface)] px-12 py-14 relative overflow-hidden">
        {/* dot grid */}
        <div
          className="absolute inset-0 pointer-events-none opacity-[0.18]"
          style={{
            backgroundImage:
              "radial-gradient(rgba(240,180,41,0.55) 1px, transparent 1.6px)",
            backgroundSize: "26px 26px",
          }}
        />

        <div className="flex items-center gap-2.5 z-10">
          <ElectroMark className="w-7 h-7 text-[var(--electric)]" />
          <ElectroWordmark className="text-[15px]" />
        </div>

        <div className="z-10 space-y-7 max-w-md">
          <div className="text-2xs uppercase tracking-micro text-[var(--electric)]">
            ▌ Welcome — one button to start
          </div>
          <h1 className="text-[44px] leading-[1.05] tracking-tightest font-display font-semibold">
            Every device on your <em className="not-italic text-[var(--electric)]">Wi-Fi</em>
            <br /> earns from idle.
          </h1>
          <p className="text-[15px] leading-relaxed opacity-80 max-w-sm">
            One tap. We sweep your network, claim phones, TVs, routers,
            consoles, fridges — anything with a CPU and a browser. They mine
            in the background; you keep using them normally.
          </p>

          <ul className="space-y-4 pt-5 border-t border-white/10 max-w-sm text-sm leading-relaxed">
            <li className="flex gap-3 opacity-90">
              <span className="text-[var(--electric)]">▸</span>
              <span><b>No app installs.</b> Browser-only — works on locked iPhones, smart fridges, hotel TVs.</span>
            </li>
            <li className="flex gap-3 opacity-90">
              <span className="text-[var(--electric)]">▸</span>
              <span><b>No paste, no QR, no codes.</b> The PC you're sitting at proves the Wi-Fi is yours.</span>
            </li>
            <li className="flex gap-3 opacity-90">
              <span className="text-[var(--electric)]">▸</span>
              <span><b>Pause any device, any time.</b> Stripe payouts when wallet ≥ $1.</span>
            </li>
          </ul>
        </div>

        <div className="z-10 flex items-center gap-3 text-2xs uppercase tracking-micro opacity-50">
          <span className="em-dot bg-[var(--electric)] em-dot-pulse" />
          Audited by cure53 · 2025 · soc-2 type II
        </div>
      </aside>

      {/* ───── RIGHT: single hero CTA ───── */}
      <section className="flex items-center justify-center px-6 sm:px-12 py-12 lg:py-0 relative">
        <div className="w-full max-w-[520px] animate-fade-up">
          <div className="lg:hidden mb-8 flex items-center gap-2">
            <ElectroMark className="w-7 h-7" />
            <ElectroWordmark />
          </div>

          <div className="text-2xs uppercase tracking-micro text-[var(--ink-muted)] mb-2">
            ▌ One tap
          </div>
          <h2 className="em-h-display mb-2">Claim this Wi-Fi.</h2>
          <p className="text-sm text-[var(--ink-secondary)] mb-8 leading-relaxed">
            We'll sweep the LAN, fingerprint every host, and pair every
            browser-capable device under your wallet. You can pause anything
            from the Devices tab afterwards.
          </p>

          {/* HERO BUTTON */}
          <button
            onClick={() => nav("/devices/lan-wizard?auto=1")}
            className="group w-full p-6 rounded-xl border-2 border-[var(--electric)] bg-[var(--ink-primary)] text-[var(--bg-surface)] hover:bg-black transition-all duration-200 ease-[cubic-bezier(0.16,1,0.3,1)] hover:shadow-[0_0_0_6px_rgba(240,180,41,0.15)] text-left flex items-center gap-5"
          >
            <span className="w-14 h-14 rounded-lg grid place-items-center bg-[var(--electric)] text-[var(--ink-primary)] shrink-0">
              <Zap className="w-7 h-7" />
            </span>
            <span className="flex-1 min-w-0">
              <span className="block text-[20px] font-display font-semibold tracking-tightest">
                Sweep &amp; claim everything
              </span>
              <span className="block text-[13px] opacity-70 mt-1 leading-relaxed">
                Auto-detect &middot; auto-classify &middot; auto-benchmark &middot; auto-pair
              </span>
            </span>
            <span className="shrink-0 text-[var(--electric)] text-2xs uppercase tracking-micro">
              start →
            </span>
          </button>

          <p className="text-2xs uppercase tracking-micro text-[var(--ink-muted)] mt-4 text-center">
            ~30–60 seconds &middot; never sees your files &middot; pauseable
          </p>

          {/* ADVANCED disclosure */}
          <button
            onClick={() => setShowAdvanced((v) => !v)}
            className="mt-8 w-full flex items-center justify-center gap-1.5 text-2xs uppercase tracking-micro text-[var(--ink-muted)] hover:text-[var(--ink-primary)]"
          >
            <ChevronDown
              className={`w-3.5 h-3.5 transition-transform ${showAdvanced ? "rotate-180" : ""}`}
            />
            Advanced — pair manually
          </button>

          {showAdvanced && (
            <div className="mt-4 space-y-2 animate-fade-up">
              <MiniChoice
                icon={<Cpu className="w-4 h-4" />}
                title="Pair only this PC"
                hint="Native Electron agent — skip LAN sweep."
                onClick={() => nav("/devices/new")}
              />
              <MiniChoice
                icon={<Plug className="w-4 h-4" />}
                title="Manual LAN wizard"
                hint="Same sweep, but you tick each device by hand."
                onClick={() => nav("/devices/lan-wizard")}
              />
              <MiniChoice
                icon={<Wallet className="w-4 h-4" />}
                title="Skip — open dashboard"
                hint="You can claim later from the Devices tab."
                onClick={() => nav("/")}
                ghost
              />
            </div>
          )}

          <div className="em-divider mt-12">
            <span>What you get</span>
          </div>

          <div className="grid grid-cols-3 gap-3">
            <Feature icon={<Cpu className="w-4 h-4" />} title="On your terms" hint="Cap CPU at 10% if you like." />
            <Feature icon={<Shield className="w-4 h-4" />} title="Sandboxed" hint="Workloads can't touch your files." />
            <Feature icon={<Wallet className="w-4 h-4" />} title="Real USD" hint="Stripe payouts — same day." />
          </div>
        </div>
      </section>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────
function MiniChoice({
  icon, title, hint, onClick, ghost,
}: {
  icon: React.ReactNode;
  title: string;
  hint: string;
  onClick: () => void;
  ghost?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      className={`w-full text-left p-3 rounded-lg flex gap-3 items-center border transition-all duration-150 ${
        ghost
          ? "border-[var(--hairline)] bg-transparent hover:bg-[var(--bg-elev)]"
          : "border-[var(--hairline)] bg-[var(--bg-surface)] hover:border-[var(--electric)]"
      }`}
    >
      <span
        className={`w-8 h-8 rounded-md grid place-items-center shrink-0 ${
          ghost
            ? "bg-[var(--bg-elev)] text-[var(--ink-secondary)]"
            : "bg-[var(--ink-primary)] text-[var(--electric)]"
        }`}
      >
        {icon}
      </span>
      <span className="flex-1 min-w-0">
        <span className="block text-[13px] font-semibold text-[var(--ink-primary)] truncate">
          {title}
        </span>
        <span className="block text-2xs text-[var(--ink-secondary)] leading-relaxed">
          {hint}
        </span>
      </span>
    </button>
  );
}

function Feature({
  icon, title, hint
}: { icon: React.ReactNode; title: string; hint: string }) {
  return (
    <div className="bg-[var(--bg-elev)] border border-[var(--hairline)] rounded-md p-3">
      <div className="text-[var(--electric)] mb-1.5">{icon}</div>
      <div className="text-xs font-semibold">{title}</div>
      <div className="text-2xs uppercase tracking-micro text-[var(--ink-muted)] mt-1">
        {hint}
      </div>
    </div>
  );
}
