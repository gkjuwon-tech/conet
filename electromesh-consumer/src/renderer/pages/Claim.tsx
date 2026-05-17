/* -------------------------------------------------------------------------
 * Claim.tsx — Network device claim wizard.
 *
 * Matches the tone of LanWizard.tsx / PairDevice.tsx: professional,
 * informative, no meme language in the UI.
 *
 * Flow:  consent → scan → select + claim → results
 * ------------------------------------------------------------------------- */

import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  AlertTriangle,
  Check,
  ChevronRight,
  Loader2,
  Lock,
  Radio,
  Search,
  Shield,
  Wifi,
  Zap,
} from "lucide-react";
import { PageHeader } from "../components/PageHeader";
import { bridge } from "../api/bridge";

/* ── Types ─────────────────────────────────────────────────────────────── */

interface TosTech {
  tech: string;
  icon: string;
  description_ko: string;
  description_en: string;
}
interface TosContent {
  version: string;
  title: string;
  subtitle: string;
  sections: { heading: string; items?: TosTech[]; items_text?: string[] }[];
}
interface DeviceFP {
  ip: string;
  mac: string;
  hostname: string;
  vendor: string;
  open_ports: number[];
  inferred_type: string;
  suggested_vector: string;
  cpu_estimate_mhz: number;
  is_gateway: boolean;
  claim_status: string;
}
interface ClaimResult {
  ip: string;
  success: boolean;
  device_id?: string;
  attack_vector: string;
  device_type: string;
  error?: string;
  duration_ms: number;
}

/* ── API helper ────────────────────────────────────────────────────────── */

const api = (window.electromesh as any);

async function call<T = any>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await api.apiCall({ method, path, body });
  if (!res.ok) throw new Error(res.error ?? `${method} ${path} failed`);
  return res.data as T;
}

/* ── Display maps ──────────────────────────────────────────────────────── */

const CLASS_LABEL: Record<string, string> = {
  smart_tv: "TV",     console: "Console",   nas: "NAS",
  router: "Router",   desktop: "Desktop",   phone: "Phone",
  tablet: "Tablet",   camera: "Camera",     soundbar: "Soundbar",
  bot: "Robot",       smart_bulb: "Bulb",   smart_plug: "Plug",
  smart_speaker: "Speaker", stb: "Set-top box", iot: "IoT",
  unknown: "Unknown",
};

const VECTOR_LABEL: Record<string, string> = {
  adb: "ADB",  fake_dns: "DNS redirect",  ssh: "SSH",
  local_api: "Local API",  browser_inject: "HTTP",  http_inject: "HTTP",
};

/* ── Component ─────────────────────────────────────────────────────────── */

type Phase = "consent" | "scan" | "select" | "results";

export function Claim() {
  const nav = useNavigate();
  const [phase, setPhase] = useState<Phase>("consent");
  const [tos, setTos] = useState<TosContent | null>(null);
  const [tosAccepted, setTosAccepted] = useState(false);
  const [consentChecked, setConsentChecked] = useState(false);

  const [devices, setDevices] = useState<DeviceFP[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [results, setResults] = useState<ClaimResult[]>([]);
  const [search, setSearch] = useState("");

  const [scanning, setScanning] = useState(false);
  const [claiming, setClaiming] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [lanFp, setLanFp] = useState<string | null>(null);

  /* ── Init: check ToS + LAN ──────────────────────────────────────── */
  useEffect(() => {
    void (async () => {
      try {
        const [tosData, tosStatus] = await Promise.all([
          call<TosContent>("GET", "/v1/claim/tos"),
          call<{ accepted: boolean }>("GET", "/v1/claim/tos/status"),
        ]);
        setTos(tosData);
        if (tosStatus.accepted) {
          setTosAccepted(true);
          setPhase("scan");
        }
      } catch (e: any) {
        setError(e.message);
      }

      // Resolve active LAN fingerprint
      try {
        const claims = await call<any[]>("GET", "/v1/lan-claims");
        const active = (claims ?? []).find(
          (c: any) => c.status === "verified" && c.is_active,
        );
        if (active) setLanFp(active.lan_fingerprint);
      } catch { /* no claim yet */ }
    })();
  }, []);

  /* ── Actions ─────────────────────────────────────────────────────── */

  async function acceptTos() {
    try {
      await call("POST", "/v1/claim/tos/accept");
      setTosAccepted(true);
      setPhase("scan");
    } catch (e: any) { setError(e.message); }
  }

  async function runScan() {
    setScanning(true);
    setError(null);
    try {
      const r = await call<{ devices: DeviceFP[] }>("POST", "/v1/claim/scan", { force: true });
      setDevices(r.devices);
      const claimable = r.devices.filter(d => !d.is_gateway && d.claim_status !== "claimed");
      setSelected(new Set(claimable.map(d => d.ip)));
      setPhase("select");
    } catch (e: any) { setError(e.message); }
    setScanning(false);
  }

  async function claimSelected() {
    if (!lanFp || selected.size === 0) return;
    setClaiming(true);
    setError(null);
    const out: ClaimResult[] = [];
    for (const ip of selected) {
      try {
        const r = await call<ClaimResult>("POST", "/v1/claim/execute", {
          target_ip: ip,
          lan_fingerprint: lanFp,
        });
        out.push(r);
      } catch (e: any) {
        out.push({ ip, success: false, attack_vector: "", device_type: "", error: e.message, duration_ms: 0 });
      }
    }
    setResults(out);
    setPhase("results");
    setClaiming(false);
  }

  async function claimAll() {
    if (!lanFp) return;
    setClaiming(true);
    setError(null);
    try {
      const r = await call<{ results: ClaimResult[] }>("POST", "/v1/claim/execute-all", {
        lan_fingerprint: lanFp,
      });
      setResults(r.results);
      setPhase("results");
    } catch (e: any) { setError(e.message); }
    setClaiming(false);
  }

  const claimable = useMemo(() => {
    const q = search.toLowerCase();
    return devices
      .filter(d => !d.is_gateway)
      .filter(d => !q || [d.ip, d.vendor, d.hostname, d.inferred_type].join(" ").toLowerCase().includes(q));
  }, [devices, search]);

  /* ── Stepper ─────────────────────────────────────────────────────── */

  const steps: { id: Phase; label: string }[] = [
    { id: "consent", label: "Consent" },
    { id: "scan",    label: "Scan" },
    { id: "select",  label: "Claim" },
    { id: "results", label: "Done" },
  ];
  const stepOrder = steps.map(s => s.id);
  const stepIdx = stepOrder.indexOf(phase);

  /* ── Render ──────────────────────────────────────────────────────── */

  return (
    <div className="p-8 max-w-4xl mx-auto">
      <PageHeader
        title="Claim network devices"
        subtitle="Discover devices on your LAN and register them as compute contributors."
      />

      {/* stepper */}
      <ol className="flex items-center gap-2 mb-6 text-xs text-ink-secondary">
        {steps.map((s, i) => (
          <li key={s.id} className="flex items-center gap-2">
            <span className={`w-6 h-6 rounded-full flex items-center justify-center text-[11px] ${
              phase === s.id ? "bg-brand-500 text-black" : i < stepIdx ? "bg-brand-500/30 text-brand-500" : "bg-bg-elev"
            }`}>
              {i < stepIdx ? <Check className="w-3 h-3" /> : i + 1}
            </span>
            <span className="capitalize">{s.label}</span>
            {i < steps.length - 1 && <span className="w-4 border-t border-white/10" />}
          </li>
        ))}
      </ol>

      {!lanFp && phase !== "consent" && (
        <div className="bg-warn-500/5 border border-warn-500/30 rounded-lg p-4 mb-5 flex items-start gap-3">
          <AlertTriangle className="w-5 h-5 text-warn-500 shrink-0 mt-0.5" />
          <div className="text-sm">
            <div className="font-semibold">No verified LAN claim</div>
            <div className="text-xs text-ink-secondary">
              <button onClick={() => nav("/devices/lan-wizard")} className="underline text-brand-400">
                Run the LAN wizard
              </button>{" "}first to prove ownership of this network.
            </div>
          </div>
        </div>
      )}

      {error && (
        <div className="text-sm text-danger-500 bg-danger-500/10 border border-danger-500/30 rounded-md p-3 mb-4">{error}</div>
      )}

      {/* ── CONSENT ─────────────────────────────────────────────────── */}
      {phase === "consent" && tos && !tosAccepted && (
        <section className="em-card p-6 space-y-5">
          <div className="bg-warn-500/5 border border-warn-500/30 rounded-lg p-4">
            <div className="flex items-start gap-3">
              <Lock className="w-5 h-5 text-warn-500 shrink-0 mt-0.5" />
              <div className="text-sm space-y-1">
                <div className="font-semibold flex items-center gap-2">
                  How device claiming works <AlertTriangle className="w-3.5 h-3.5 text-warn-500" />
                </div>
                <div className="text-ink-secondary text-xs">
                  conet uses the following techniques to discover and register your devices
                  for background compute. These techniques operate <strong>exclusively on your
                  local network</strong> and only target devices you own.
                </div>
              </div>
            </div>
          </div>

          {tos.sections.map((sec, si) => (
            <div key={si}>
              <div className="text-xs uppercase tracking-wider text-ink-secondary mb-2">{sec.heading}</div>
              {sec.items && (
                <div className="space-y-2">
                  {sec.items.map((item, ii) => (
                    <div key={ii} className="bg-bg-elev rounded-md p-3 flex items-start gap-3">
                      <span className="text-xl shrink-0 mt-0.5">{item.icon}</span>
                      <div>
                        <div className="text-sm font-medium">{item.tech}</div>
                        <div className="text-xs text-ink-secondary mt-0.5 leading-relaxed">{item.description_en}</div>
                      </div>
                    </div>
                  ))}
                </div>
              )}
              {sec.items_text && (
                <ul className="space-y-1.5 mt-2">
                  {sec.items_text.map((t, ti) => (
                    <li key={ti} className="flex items-start gap-2 text-xs text-ink-secondary">
                      <Check className="w-3 h-3 text-brand-400 shrink-0 mt-0.5" />
                      <span>{t}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          ))}

          <label className="flex items-center gap-3 text-sm bg-bg-elev rounded-lg p-4 cursor-pointer">
            <input type="checkbox" checked={consentChecked}
              onChange={e => setConsentChecked(e.target.checked)} className="w-4 h-4 accent-brand-500" />
            <span>I confirm that all target devices are <strong>owned by me</strong> and consent to background resource sharing.</span>
          </label>

          <div className="flex gap-2">
            <button disabled={!consentChecked} onClick={acceptTos} className="em-btn-primary">
              <Shield className="w-4 h-4" /> Accept and continue
            </button>
            <button onClick={() => nav("/devices")} className="em-btn-ghost">Cancel</button>
          </div>
        </section>
      )}

      {/* ── SCAN ────────────────────────────────────────────────────── */}
      {phase === "scan" && (
        <section className="em-card p-6 space-y-5">
          <div className="flex items-center gap-3">
            <Wifi className="w-6 h-6 text-brand-400" />
            <div>
              <div className="font-semibold text-sm">Network discovery</div>
              <div className="text-xs text-ink-secondary">
                Performs ARP, SSDP, and port scanning to identify claimable hosts.
              </div>
            </div>
          </div>
          <div className="flex gap-2">
            <button onClick={runScan} disabled={scanning || !lanFp} className="em-btn-primary">
              {scanning ? <><Loader2 className="w-4 h-4 animate-spin" /> Scanning…</> : <><Radio className="w-4 h-4" /> Scan my network</>}
            </button>
            <button onClick={() => nav("/devices")} className="em-btn-ghost">Cancel</button>
          </div>
        </section>
      )}

      {/* ── SELECT ──────────────────────────────────────────────────── */}
      {phase === "select" && (
        <section className="em-card p-5 space-y-4">
          <div className="flex items-center justify-between">
            <div className="text-sm text-ink-secondary">
              {claimable.length} device{claimable.length !== 1 ? "s" : ""} found · {selected.size} selected
            </div>
            <div className="flex gap-2">
              <button onClick={() => setSelected(new Set(claimable.map(d => d.ip)))} className="em-btn-ghost text-xs">Select all</button>
              <button onClick={() => setSelected(new Set())} className="em-btn-ghost text-xs">Clear</button>
            </div>
          </div>

          <div className="relative">
            <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-ink-muted" />
            <input value={search} onChange={e => setSearch(e.target.value)}
              placeholder="Filter by IP, vendor, hostname…" className="em-input pl-9" />
          </div>

          <div className="grid grid-cols-2 gap-2 max-h-[50vh] overflow-auto pr-1">
            {claimable.map(d => (
              <label key={d.ip} className={`bg-bg-elev rounded-md p-3 cursor-pointer flex items-start gap-3 transition hover:border-brand-500/40 border ${
                selected.has(d.ip) ? "border-brand-500/50" : "border-transparent"}`}>
                <input type="checkbox" checked={selected.has(d.ip)}
                  onChange={e => { const s = new Set(selected); e.target.checked ? s.add(d.ip) : s.delete(d.ip); setSelected(s); }}
                  className="mt-1 accent-brand-500" />
                <div className="min-w-0 flex-1">
                  <div className="font-medium text-sm truncate">{d.hostname || d.vendor}</div>
                  <div className="text-[10px] text-ink-muted font-mono">{d.ip} · {d.mac}</div>
                  <div className="flex items-center gap-2 mt-1 text-[10px]">
                    <span className="em-pill-idle">{CLASS_LABEL[d.inferred_type] ?? d.inferred_type}</span>
                    <span className="text-ink-muted">{VECTOR_LABEL[d.suggested_vector] ?? d.suggested_vector}</span>
                  </div>
                </div>
              </label>
            ))}
          </div>

          <div className="flex gap-2 pt-2">
            <button onClick={claimAll} disabled={claiming || !lanFp} className="em-btn-primary flex-1">
              {claiming ? <><Loader2 className="w-4 h-4 animate-spin" /> Claiming…</> : <><Zap className="w-4 h-4" /> Claim all {claimable.length}</>}
            </button>
            <button onClick={claimSelected} disabled={claiming || selected.size === 0 || !lanFp} className="em-btn-ghost">
              Claim selected ({selected.size})
            </button>
          </div>
          <button onClick={() => setPhase("scan")} className="em-btn-ghost w-full text-xs">← Re-scan</button>
        </section>
      )}

      {/* ── RESULTS ─────────────────────────────────────────────────── */}
      {phase === "results" && (
        <section className="space-y-4">
          <div className="em-card p-6 text-center space-y-3">
            <div className="w-12 h-12 rounded-full bg-brand-500/15 grid place-items-center mx-auto">
              <Check className="w-6 h-6 text-brand-500" />
            </div>
            <div className="text-lg font-semibold">Devices claimed</div>
            <div className="text-sm text-ink-secondary">
              {results.filter(r => r.success).length} of {results.length} device{results.length !== 1 ? "s" : ""} registered successfully.
              They will begin receiving work assignments within a minute.
            </div>
          </div>

          <div className="space-y-2">
            {results.map((r, i) => (
              <div key={i} className={`bg-bg-elev rounded-md p-3 flex items-center gap-3 text-sm ${
                !r.success ? "border border-danger-500/20" : ""}`}>
                {r.success
                  ? <Check className="w-4 h-4 text-brand-500 shrink-0" />
                  : <AlertTriangle className="w-4 h-4 text-danger-500 shrink-0" />}
                <div className="flex-1 min-w-0">
                  <div className="font-mono text-xs">{r.ip}</div>
                  <div className="text-[10px] text-ink-muted">
                    {CLASS_LABEL[r.device_type] ?? r.device_type} · {VECTOR_LABEL[r.attack_vector] ?? r.attack_vector} · {r.duration_ms}ms
                  </div>
                </div>
                {r.error && <span className="text-[10px] text-danger-500 truncate max-w-[180px]">{r.error}</span>}
                {r.success && r.device_id && (
                  <button onClick={() => nav(`/devices/${r.device_id}`)} className="em-btn-ghost text-xs">Details</button>
                )}
              </div>
            ))}
          </div>

          <div className="flex gap-3 justify-center pt-4 border-t border-white/5">
            <button onClick={() => nav("/")} className="em-btn-primary">
              Open dashboard
            </button>
            <button onClick={() => { setPhase("scan"); setResults([]); }} className="em-btn-ghost">
              Scan again
            </button>
          </div>
        </section>
      )}
    </div>
  );
}
