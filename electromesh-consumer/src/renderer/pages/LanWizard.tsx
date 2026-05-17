import { useEffect, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import {
  ShieldCheck,
  Wifi,
  Search,
  Check,
  AlertTriangle,
  Lock,
  KeyRound,
  QrCode
} from "lucide-react";
import { QRCodeSVG } from "qrcode.react";
import { PageHeader } from "../components/PageHeader";
import { fmtRelative } from "../lib/format";

interface LanApi {
  scan: () => Promise<{ ok: boolean; result?: ScanResult; error?: string }>;
  onScanProgress: (cb: (event: ScanProgress) => void) => () => void;
  claimRequest: (p: {
    lan_fingerprint: string;
    label?: string;
    gateway_mac?: string;
    advertised_subnet?: string;
  }) => Promise<{ ok: boolean; claim?: LanClaim; error?: string }>;
  claimVerify: (p: {
    lan_fingerprint: string;
    otp: string;
  }) => Promise<{ ok: boolean; claim?: LanClaim; error?: string }>;
  claimList: () => Promise<{ ok: boolean; claims?: LanClaim[]; error?: string }>;
  pairAll: (p: {
    devices: LanDevice[];
    lanFingerprint: string;
    skipRandomized?: boolean;
    skipRouter?: boolean;
  }) => Promise<{
    ok: boolean;
    registered?: { id: string; label: string; class: string; status?: string }[];
    failures?: { label: string; error: string }[];
    error?: string;
  }>;
  onPairProgress: (cb: (event: PairEvent) => void) => () => void;
}

interface PhoneAgentApi {
  status: () => Promise<{ ready: boolean; gatewayIp: string; port: number }>;
  activations: () => Promise<{
    ok: boolean;
    activations?: {
      device_id: string;
      label: string;
      url: string;
      status: string;
    }[];
    error?: string;
  }>;
}

const lanApi = (window.electromesh as unknown as { lan: LanApi }).lan;
const phoneAgentApi = (window.electromesh as unknown as { phoneAgent: PhoneAgentApi }).phoneAgent;

interface LanDevice {
  ip: string;
  mac: string;
  hostname: string | null;
  vendor: string;
  device_class: string;
  label: string;
  randomized_mac: boolean;
  lan_fingerprint: string;
}

interface ScanResult {
  ourIp: string | null;
  ourMac: string | null;
  gatewayMac: string | null;
  lanFingerprint: string | null;
  subnet: string | null;
  iface: string | null;
  devices: LanDevice[];
}

type ScanProgress =
  | { type: "info"; message: string }
  | { type: "ping"; done: number; total: number }
  | { type: "device"; device: LanDevice }
  | { type: "done"; result: ScanResult };

interface LanClaim {
  id: string;
  lan_fingerprint: string;
  status: string;
  label: string | null;
  otp_expires_at: string | null;
  grace_until: string | null;
  verified_at: string | null;
  delivered_otp_dev: string | null;
}

type PairEvent =
  | { stage: "scan"; event: ScanProgress }
  | { stage: "registering"; device: LanDevice }
  | { stage: "benchmarking"; device: LanDevice; label: string }
  | { stage: "bench-finished"; device: LanDevice; label: string; h100eq: number }
  | { stage: "bench-failed"; device: LanDevice; label: string; error: string }
  | { stage: "registered"; id: string; label: string; h100eq: number }
  | { stage: "failed"; label: string; error: string }
  | { stage: "benchmark-start" };

const CLASS_LABEL: Record<string, string> = {
  smart_bulb: "Bulb",
  smart_plug: "Plug",
  smart_tv: "TV",
  fridge: "Fridge",
  washer: "Washer",
  dryer: "Dryer",
  microwave: "Microwave",
  router: "Router",
  nas: "NAS",
  desktop: "Desktop",
  laptop: "Laptop",
  console: "Console",
  phone: "Phone",
  tablet: "Tablet",
  camera: "Camera",
  soundbar: "Soundbar",
  stb: "Set-top box",
  gpu_rig: "GPU rig",
  other_iot: "IoT"
};

type Step = "intro" | "scan" | "claim" | "verify" | "pair" | "benchmark" | "activate";

export function LanWizard() {
  const nav = useNavigate();
  const [searchParams] = useSearchParams();
  const autoMode = searchParams.get("auto") === "1";
  const [step, setStep] = useState<Step>("intro");
  const [scanLog, setScanLog] = useState<string[]>([]);
  const [pingProgress, setPingProgress] = useState<{ done: number; total: number } | null>(null);
  const [scan, setScan] = useState<ScanResult | null>(null);
  const [existingClaim, setExistingClaim] = useState<LanClaim | null>(null);
  const [claim, setClaim] = useState<LanClaim | null>(null);
  const [otpInput, setOtpInput] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [pairLog, setPairLog] = useState<PairEvent[]>([]);
  const [skipRouter, setSkipRouter] = useState(true);
  const [skipRandomized, setSkipRandomized] = useState(false);

  const [pairedDevices, setPairedDevices] = useState<{ id: string; label: string; class: string; status?: string; activationUrl?: string }[]>([]);
  const [serverError, setServerError] = useState<string | null>(null);

  const logRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [scanLog, pairLog]);

  useEffect(() => {
    let timer: any = null;
    if (step === "activate") {
      void checkAllStatuses();
      timer = setInterval(() => void checkAllStatuses(), 4000);
    }
    return () => {
      if (timer) clearInterval(timer);
    };
  }, [step]);

  async function checkAllStatuses() {
    // Don't show busy state during background polling to avoid UI flickering
    try {
      const acts = await phoneAgentApi.activations();
      if (!acts.ok) {
        setServerError(acts.error ?? "Failed to connect to internal activation server");
      }
      const res = await (window.electromesh as any).devices.list();
      const remoteDevices = res.devices || [];

      setPairedDevices((prev) =>
        prev.map((d) => {
          const remote = remoteDevices.find((rd: any) => d.id === rd.id);
          const act = acts.activations?.find((a) => a.device_id === d.id);
          return {
            ...d,
            status: remote?.status ?? d.status,
            activationUrl: act?.url ?? d.activationUrl
          };
        })
      );
    } catch (e) {
      console.error("status check failed", e);
    }
  }

  useEffect(() => {
    const off1 = lanApi.onScanProgress((event) => {
      if (event.type === "info") setScanLog((l) => [...l, event.message]);
      if (event.type === "ping") setPingProgress({ done: event.done, total: event.total });
      if (event.type === "device")
        setScanLog((l) => [
          ...l,
          `discovered ${CLASS_LABEL[event.device.device_class] ?? event.device.device_class}: ${event.device.label} (${event.device.mac})`
        ]);
      if (event.type === "done") {
        setScan(event.result);
        setPingProgress(null);
      }
    });
    const off2 = lanApi.onPairProgress((event) => {
      setPairLog((l) => [...l, event]);

      if (event.stage === "benchmark-start") {
        setStep("benchmark");
      }
    });
    return () => {
      off1();
      off2();
    };
  }, []);

  // ── auto-mode: ?auto=1 means the Onboarding hero CTA sent us here.
  //
  // Drive the wizard forward without user input:
  //   intro → scan → (if claim exists) pair → activate
  //                 \-> if no claim, request OTP. If backend returns
  //                     `delivered_otp_dev` (dev-mode), auto-fill +
  //                     verify. Otherwise stop and let the user
  //                     paste the code they got via email/SMS.
  const autoTriggered = useRef({ intro: false, pair: false, otp: false });
  useEffect(() => {
    if (!autoMode || busy || error) return;
    if (step === "intro" && !autoTriggered.current.intro) {
      autoTriggered.current.intro = true;
      void startScan();
    } else if (step === "claim" && !autoTriggered.current.otp) {
      autoTriggered.current.otp = true;
      void requestOtp();
    } else if (step === "pair" && !autoTriggered.current.pair) {
      autoTriggered.current.pair = true;
      void runPairAll();
    }
  }, [step, autoMode, busy, error]);

  // Auto-fill + auto-verify the OTP when the backend echoed it back
  // (dev mode / loopback delivery).
  useEffect(() => {
    if (!autoMode) return;
    if (step !== "verify") return;
    if (!claim?.delivered_otp_dev) return;
    if (otpInput) return;
    setOtpInput(claim.delivered_otp_dev);
    // verifyOtp reads otpInput from closure — give React one tick to flush.
    const t = setTimeout(() => void verifyOtp(), 50);
    return () => clearTimeout(t);
  }, [step, claim, autoMode, otpInput]);

  async function startScan() {
    setStep("scan");
    setScanLog([]);
    setError(null);
    setBusy(true);
    const res = await lanApi.scan();
    setBusy(false);
    if (!res.ok || !res.result) {
      setError(res.error ?? "scan failed");
      return;
    }
    setScan(res.result);
    if (!res.result.lanFingerprint) {
      setError("no LAN fingerprint — please connect to a WiFi first");
      return;
    }
    const list = await lanApi.claimList();
    const claims = Array.isArray(list.claims) ? list.claims : [];
    if (list.ok && claims.length > 0) {
      const owned = claims.find(
        (c) =>
          c.lan_fingerprint === res.result!.lanFingerprint &&
          c.status === "verified" &&
          (c as { is_active?: boolean }).is_active !== false
      );
      if (owned) {
        setExistingClaim(owned);
        setStep("pair");
        return;
      }
    }
    setStep("claim");
  }

  async function requestOtp() {
    if (!scan?.lanFingerprint) return;
    setBusy(true);
    setError(null);
    const res = await lanApi.claimRequest({
      lan_fingerprint: scan.lanFingerprint,
      label: scan.subnet ?? "this LAN",
      gateway_mac: scan.gatewayMac ?? undefined,
      advertised_subnet: scan.subnet ?? undefined
    });
    setBusy(false);
    if (!res.ok || !res.claim) {
      setError(res.error ?? "OTP request failed");
      return;
    }
    setClaim(res.claim);
    setStep("verify");
  }

  async function verifyOtp() {
    if (!scan?.lanFingerprint) return;
    setBusy(true);
    setError(null);
    const res = await lanApi.claimVerify({
      lan_fingerprint: scan.lanFingerprint,
      otp: otpInput.trim()
    });
    setBusy(false);
    if (!res.ok || !res.claim) {
      setError(res.error ?? "verification failed");
      return;
    }
    setExistingClaim(res.claim);
    setStep("pair");
  }

  async function runPairAll() {
    if (!scan?.lanFingerprint || !scan.devices.length) {
      setError("re-scan required");
      return;
    }
    setBusy(true);
    setPairLog([]);
    setError(null);
    const res = await lanApi.pairAll({
      devices: scan.devices,
      lanFingerprint: scan.lanFingerprint,
      skipRandomized,
      skipRouter
    });
    setBusy(false);
    if (!res.ok) {
      setError(res.error ?? "pair-all failed");
      return;
    }
    if (res.failures && res.failures.length > 0) {
      setError(
        `Paired ${res.registered?.length ?? 0} of ${(res.registered?.length ?? 0) + res.failures.length}. Failures: ${res.failures.map((f) => `${f.label} (${f.error})`).join("; ")}`
      );
    }
    
    setPairedDevices(
      (res.registered || []).map((d) => ({
        id: d.id,
        label: d.label,
        class: d.class,
        status: d.status
      }))
    );

    setServerError(null);
    // Fetch initial activation URLs
    try {
      const acts = await phoneAgentApi.activations();
      if (acts.ok && acts.activations) {
        setPairedDevices((prev) =>
          prev.map((d) => {
            const a = acts.activations?.find((aa) => aa.device_id === d.id);
            return a ? { ...d, activationUrl: a.url } : d;
          })
        );
      } else {
        setServerError(acts.error ?? "Activation server is offline");
      }
    } catch (e) {
      console.warn("initial activation fetch failed", e);
      setServerError("Could not reach activation server");
    }

    setStep("activate");
  }

  return (
    <div className="p-8 max-w-4xl mx-auto">
      <PageHeader
        title="Pair every device on this WiFi"
        subtitle={`Discover and lease compute from every gadget on your LAN. ${scan?.subnet ? `Currently on ${scan.subnet}.` : "Connect to your home WiFi to begin."}`}
      />

      <Stepper step={step} />

      {error && (
        <div className="text-sm text-danger-500 bg-danger-500/10 border border-danger-500/30 rounded-md p-3 mb-4">
          {error}
        </div>
      )}

      {step === "intro" && (
        <section className="em-card p-6 space-y-5">
          <SecurityNote />
          <div className="flex gap-2">
            <button onClick={() => void startScan()} className="em-btn-primary">
              <Search className="w-4 h-4" />
              Scan my WiFi
            </button>
            <button onClick={() => nav("/devices")} className="em-btn-ghost">
              Cancel
            </button>
          </div>
        </section>
      )}

      {step === "scan" && (
        <section className="em-card p-5 space-y-4">
          <div className="font-semibold text-sm flex items-center gap-2">
            <Wifi className="w-4 h-4 text-brand-500" /> Scanning local /24…
          </div>
          {pingProgress && (
            <div>
              <div className="text-xs text-ink-secondary mb-1">
                ICMP sweep {pingProgress.done}/{pingProgress.total}
              </div>
              <div className="h-1.5 bg-bg-elev rounded-full overflow-hidden">
                <div
                  className="h-full bg-brand-500 transition-all"
                  style={{ width: `${(pingProgress.done / pingProgress.total) * 100}%` }}
                />
              </div>
            </div>
          )}
          <div
            ref={logRef}
            className="bg-bg-elev rounded-lg p-3 font-mono text-xs h-44 overflow-auto"
          >
            {scanLog.map((l, i) => (
              <div key={i} className="text-ink-secondary">
                {l}
              </div>
            ))}
          </div>
        </section>
      )}

      {step === "claim" && scan && (
        <section className="em-card p-6 space-y-5">
          <SecurityNote />
          <div className="bg-bg-elev rounded-lg p-4 text-sm">
            <div className="text-ink-secondary text-xs uppercase tracking-wider mb-1">
              LAN to claim
            </div>
            <div className="font-mono text-xs selectable">
              fp: {scan.lanFingerprint?.slice(0, 24)}…
            </div>
            <div className="font-mono text-xs">subnet: {scan.subnet}</div>
            <div className="font-mono text-xs">
              gateway: {scan.gatewayMac ?? "—"} · {scan.devices.length} hosts visible
            </div>
          </div>
          <button
            disabled={busy}
            onClick={() => void requestOtp()}
            className="em-btn-primary"
          >
            <KeyRound className="w-4 h-4" />
            Email me an OTP
          </button>
        </section>
      )}

      {step === "verify" && claim && (
        <section className="em-card p-6 space-y-5">
          <div className="text-sm">
            We've sent a one-time code to your registered email. Enter it below to
            prove ownership of this WiFi.
          </div>
          {claim.delivered_otp_dev && (
            <div className="bg-warn-500/10 border border-warn-500/30 rounded-md p-3 text-xs">
              <strong className="text-warn-500">DEV-MODE OTP:</strong>{" "}
              <code className="font-mono">{claim.delivered_otp_dev}</code>{" "}
              <span className="text-ink-secondary">
                (in production this would be delivered via email only)
              </span>
            </div>
          )}
          <div>
            <label className="em-label">One-time code</label>
            <input
              autoFocus
              inputMode="numeric"
              maxLength={8}
              value={otpInput}
              onChange={(e) => setOtpInput(e.target.value)}
              className="em-input font-mono tracking-widest text-center text-lg"
              placeholder="••••••"
            />
            <div className="text-[11px] text-ink-secondary mt-1">
              Expires {fmtRelative(claim.otp_expires_at)}
            </div>
          </div>
          <div className="flex gap-2">
            <button
              disabled={busy || otpInput.length < 4}
              onClick={() => void verifyOtp()}
              className="em-btn-primary"
            >
              Verify
            </button>
            <button
              onClick={() => setStep("claim")}
              className="em-btn-ghost"
              disabled={busy}
            >
              Resend code
            </button>
          </div>
        </section>
      )}

      {step === "pair" && scan && existingClaim && (
        <section className="em-card p-6 space-y-5">
          <div className="flex items-center gap-2 text-sm text-brand-400">
            <ShieldCheck className="w-4 h-4" />
            LAN claimed by you · grace_until {fmtRelative(existingClaim.grace_until)}
          </div>

          <div>
            <div className="text-xs uppercase tracking-wider text-ink-secondary mb-2">
              Devices visible on this LAN
            </div>
            <div className="grid grid-cols-2 gap-2">
              {scan.devices.map((d) => (
                <div
                  key={d.mac}
                  className="bg-bg-elev rounded-md p-3 flex items-center justify-between text-xs"
                >
                  <div>
                    <div className="font-medium">{d.label}</div>
                    <div className="text-ink-secondary">
                      {CLASS_LABEL[d.device_class] ?? d.device_class} · {d.ip}
                    </div>
                  </div>
                  {d.randomized_mac && (
                    <span className="em-pill-warn">rand-mac</span>
                  )}
                </div>
              ))}
            </div>
          </div>

          <div className="flex flex-wrap gap-4 text-sm">
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={skipRouter}
                onChange={(e) => setSkipRouter(e.target.checked)}
              />
              Skip the gateway/router
            </label>
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={skipRandomized}
                onChange={(e) => setSkipRandomized(e.target.checked)}
              />
              Skip privacy-randomized phones
            </label>
          </div>

          <div className="flex gap-2">
            <button
              disabled={busy}
              onClick={() => void runPairAll()}
              className="em-btn-primary"
            >
              <Wifi className="w-4 h-4" />
              Pair all {scan.devices.length}
            </button>
            <button onClick={() => nav("/devices")} className="em-btn-ghost">
              Skip
            </button>
          </div>

          {pairLog.length > 0 && (
            <div
              ref={logRef}
              className="bg-bg-elev rounded-lg p-3 font-mono text-xs max-h-64 overflow-auto"
            >
              {pairLog.filter((p) => ["registering", "registered", "failed"].includes(p.stage)).map((p, i) => (
                <div key={i} className="text-ink-secondary">
                  #{i + 1}{" "}
                  {p.stage === "registering" &&
                    `→ registering ${(p as { device: LanDevice }).device.label}`}
                  {p.stage === "registered" &&
                    `✓ ${(p as { label: string }).label} registered`}
                  {p.stage === "failed" &&
                    `✗ ${(p as { label: string }).label}: ${(p as { error: string }).error}`}
                </div>
              ))}
            </div>
          )}
        </section>
      )}

      {step === "benchmark" && (
        <section className="em-card p-6 space-y-5">
          <div className="font-medium mb-2">Benchmarking devices</div>
          <div className="text-xs text-ink-secondary mb-4">
            Running synthetic benchmarks on paired LAN devices. This estimates CPU/SHA-256 throughput and memory-hard hashing.
          </div>

          <div
            ref={logRef}
            className="bg-bg-elev rounded-lg p-3 font-mono text-xs max-h-64 overflow-auto"
          >
            {pairLog.filter((p) => ["benchmarking", "bench-finished", "bench-failed"].includes(p.stage)).map((p, i) => (
              <div key={i} className="text-ink-secondary">
                {p.stage === "benchmarking" &&
                  `→ benchmarking ${(p as { label: string }).label}…`}
                {p.stage === "bench-finished" &&
                  `✓ benchmark done ${(p as { label: string }).label} (h100eq=${(p as { h100eq: number }).h100eq.toFixed(6)})`}
                {p.stage === "bench-failed" &&
                  `✗ benchmark failed ${(p as { label: string }).label}: ${(p as { error: string }).error}`}
              </div>
            ))}
          </div>
        </section>
      )}

      {step === "activate" && (
        <section className="em-card p-6 space-y-6">
          <div className="text-center space-y-3">
            <div className="w-12 h-12 rounded-full bg-brand-500/15 grid place-items-center mx-auto">
              <Check className="w-6 h-6 text-brand-500" />
            </div>
            <div className="text-lg font-semibold">Devices Registered!</div>
            <div className="text-sm text-ink-secondary max-w-md mx-auto">
              Your devices are now in the conet registry. To start earning, you must activate the agent on each device.
            </div>
            {serverError && (
              <div className="bg-danger-500/10 border border-danger-500/30 rounded-md p-3 text-xs text-danger-500 max-w-md mx-auto">
                <strong>Error:</strong> {serverError}
              </div>
            )}
            <button
              onClick={() => void checkAllStatuses()}
              disabled={busy}
              className="em-btn-ghost text-xs"
            >
              {busy ? "Checking..." : "Refresh status of all devices"}
            </button>
          </div>

          <div className="grid grid-cols-1 gap-4">
            {pairedDevices.length === 0 ? (
              <div className="text-center text-sm text-ink-secondary p-10 border border-dashed border-white/10 rounded-lg">
                No new devices were paired.
              </div>
            ) : (
              pairedDevices.map((d) => (
                <div key={d.id} className="bg-bg-elev border border-black/5 rounded-lg p-5">
                  <div className="flex items-start justify-between mb-4">
                    <div>
                      <div className="font-semibold text-sm flex items-center gap-2">
                        {d.label}
                        <span className="text-[10px] bg-brand-500/10 text-brand-400 px-1.5 py-0.5 rounded font-mono uppercase tracking-wider">
                          {CLASS_LABEL[d.class] ?? d.class}
                        </span>
                      </div>
                      <div className="text-[10px] text-ink-muted font-mono mt-0.5">{d.id}</div>
                    </div>
                    <div className="flex items-center gap-2">
                      <span className={`em-pill-${(d.status === "idle" || d.status === "leased") ? "active" : "idle"} text-[10px]`}>
                        {d.status || "pending"}
                      </span>
                    </div>
                  </div>

                  <div className="text-sm text-ink-secondary border-t border-white/5 pt-4">
                    {d.class === "phone" || d.class === "tablet" ? (
                      <div className="space-y-4">
                        <div className="flex gap-4 items-start">
                          <div className="bg-white p-2 rounded-lg shrink-0 shadow-sm border border-black/10">
                            {d.activationUrl ? (
                              <QRCodeSVG value={d.activationUrl} size={100} />
                            ) : (
                              <div className="w-[100px] h-[100px] bg-bg-base animate-pulse rounded flex items-center justify-center">
                                <QrCode className="w-6 h-6 text-ink-muted" />
                              </div>
                            )}
                          </div>
                          <div className="space-y-2">
                            <p className="text-xs font-medium text-ink-primary">Scan to start mining</p>
                            <p className="text-[11px] leading-relaxed">
                              Open your phone camera, scan this QR code, and keep the browser tab open.
                            </p>
                            <button 
                              onClick={() => {
                                navigator.clipboard.writeText(d.activationUrl!);
                                alert("Copied to clipboard!");
                              }}
                              className="text-[10px] text-brand-500 hover:underline flex items-center gap-1"
                            >
                              Copy URL manually
                            </button>
                          </div>
                        </div>
                        {d.activationUrl && (
                           <div className="bg-black/20 p-2 rounded font-mono text-[9px] break-all border border-white/5 text-ink-muted">
                              {d.activationUrl}
                           </div>
                        )}
                      </div>
                    ) : d.class === "router" ? (
                      <div className="space-y-2">
                        <p>1. SSH into the router (<code className="bg-black/10 px-1 py-0.5 rounded">ssh root@{scan?.gatewayMac ? "192.168.0.1" : "gateway"}</code>).</p>
                        <p>2. Run the conet installer script to start the background daemon.</p>
                      </div>
                    ) : d.class === "smart_tv" || d.class === "stb" ? (
                      <div className="space-y-2">
                        <p>1. Open the conet App on your TV/Set-top Box.</p>
                        <p>2. Authorize via the local network prompt.</p>
                      </div>
                    ) : d.class === "fridge" ? (
                      <div className="space-y-2">
                        <p>1. Open the Fridge's browser.</p>
                        <p>2. Go to the pairing URL and enter the PIN code generated from the CLI.</p>
                      </div>
                    ) : d.class === "nas" ? (
                      <div className="space-y-2">
                        <p>1. Open your NAS Docker manager.</p>
                        <p>2. Deploy: <code className="bg-black/10 px-1 py-0.5 rounded">docker run electromesh/agent --token ...</code></p>
                      </div>
                    ) : (
                      <p className="text-xs">
                        For IoT devices (Bulbs, Plugs, Vacuums, Cameras, Microwaves, Soundbars),
                        the local bridge will automatically push the lightweight worker
                        when the device is idle.
                      </p>
                    )}
                  </div>
                </div>
              ))
            )}
          </div>

          <div className="flex gap-3 justify-center mt-8 pt-6 border-t border-white/5">
            <button 
              onClick={() => nav("/")} 
              className="em-btn-primary"
              disabled={pairedDevices.length > 0 && !pairedDevices.some(d => d.status === "idle" || d.status === "leased")}
            >
              Finish Onboarding
            </button>
            <button onClick={() => setStep("pair")} className="em-btn-ghost">
              Back to List
            </button>
          </div>
          {pairedDevices.length > 0 && !pairedDevices.some(d => d.status === "idle" || d.status === "leased") && (
            <p className="text-center text-[10px] text-warn-500/70 italic">
              * Waiting for at least one device to come online before finishing...
            </p>
          )}
        </section>
      )}
    </div>
  );
}

function Stepper({ step }: { step: Step }) {
  const steps: { id: Step; label: string }[] = [
    { id: "intro", label: "Intro" },
    { id: "scan", label: "Scan" },
    { id: "claim", label: "Claim" },
    { id: "verify", label: "Verify" },
    { id: "pair", label: "Pair" },
    { id: "benchmark", label: "Benchmark" },
    { id: "done", label: "Done" }
  ];
  const order = steps.map((s) => s.id);
  const idx = order.indexOf(step);
  return (
    <ol className="flex items-center gap-2 mb-6 text-xs text-ink-secondary">
      {steps.map((s, i) => {
        const reached = i <= idx;
        return (
          <li key={s.id} className="flex items-center gap-2">
            <span
              className={`w-6 h-6 rounded-full flex items-center justify-center text-[11px] ${
                step === s.id
                  ? "bg-brand-500 text-black"
                  : reached
                    ? "bg-brand-500/30 text-brand-500"
                    : "bg-bg-elev"
              }`}
            >
              {i + 1 > idx ? i + 1 : <Check className="w-3 h-3" />}
            </span>
            <span className="capitalize">{s.label}</span>
            {i < steps.length - 1 && <span className="w-4 border-t border-white/10" />}
          </li>
        );
      })}
    </ol>
  );
}

function SecurityNote() {
  return (
    <div className="bg-warn-500/5 border border-warn-500/30 rounded-lg p-4">
      <div className="flex items-start gap-3">
        <Lock className="w-5 h-5 text-warn-500 shrink-0 mt-0.5" />
        <div className="text-sm space-y-1">
          <div className="font-semibold flex items-center gap-2">
            Why we ask for an OTP <AlertTriangle className="w-3.5 h-3.5 text-warn-500" />
          </div>
          <div className="text-ink-secondary text-xs">
            Without LAN proof-of-ownership, anyone walking into a Starbucks could
            pair every iPhone in the room and steal earnings.
            conet requires:
            <ul className="list-disc list-inside mt-1 space-y-0.5">
              <li>OTP delivered to your registered email</li>
              <li>Account ≥ 24h old before claiming a new LAN</li>
              <li>Max 5 verified LAN claims per user</li>
              <li>24h grace period — real owners can dispute and revert all earnings</li>
            </ul>
          </div>
        </div>
      </div>
    </div>
  );
}
