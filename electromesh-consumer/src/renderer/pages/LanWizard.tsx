import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Wifi, Plug, Smartphone } from "lucide-react";
import { bridge } from "../api/bridge";
import { StatusPill } from "../components/StatusPill";
import { EmptyState } from "../components/EmptyState";
import { formatRelative } from "../lib/format";

function looksLikeAndroid(d: { device_class?: string; vendor?: string; randomized_mac?: boolean; label?: string; hostname?: string | null }): boolean {
  const cls = (d.device_class || "").toLowerCase();
  const vendor = (d.vendor || "").toLowerCase();
  const label = `${d.label || ""} ${d.hostname || ""}`.toLowerCase();
  if (cls === "android" || cls === "phone" || cls === "tablet") return true;
  if (/(samsung|xiaomi|oppo|oneplus|huawei|pixel|lg electronics|motorola|sony mobile)/.test(vendor)) return true;
  if (/(android|galaxy|pixel|oneplus)/.test(label)) return true;
  return false;
}

interface DiscoveredDevice {
  ip: string;
  mac: string;
  hostname: string | null;
  vendor: string;
  device_class: string;
  label: string;
  randomized_mac?: boolean;
  lan_fingerprint?: string;
  last_seen_at?: string;
  match_kind?: string;
  is_self?: boolean;
}

interface ScanResult {
  count: number;
  items: DiscoveredDevice[];
  lan_fingerprint?: string;
}

type Stage = "intro" | "scanning" | "review" | "ownership_verify" | "claiming" | "done";
type VerifyMethod = "pin" | "mac";

export function LanWizard() {
  const nav = useNavigate();
  const [stage, setStage] = useState<Stage>("intro");
  const [scanProgress, setScanProgress] = useState<string>("");
  const [pairProgress, setPairProgress] = useState<{ paired: number; total: number; last?: string }>({ paired: 0, total: 0 });
  const [result, setResult] = useState<ScanResult | null>(null);
  const [selected, setSelected] = useState<Record<string, boolean>>({});
  const [skipRandomized, setSkipRandomized] = useState(true);
  const [skipRouter, setSkipRouter] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Ownership verification state
  const [verifyIndex, setVerifyIndex] = useState(0);
  const [verifyMethod, setVerifyMethod] = useState<VerifyMethod>("pin");
  const [verifyPin, setVerifyPin] = useState("");
  const [verifyMac, setVerifyMac] = useState("");
  const [verifySerial, setVerifySerial] = useState("");
  const [currentPin, setCurrentPin] = useState<string | null>(null);
  const [verifying, setVerifying] = useState(false);
  const [verified, setVerified] = useState<Record<string, boolean>>({});

  useEffect(() => {
    const offScan = bridge.lan.onScanProgress((p) => {
      const pp = p as { phase?: string; pct?: number };
      setScanProgress(pp.phase ? `${pp.phase} · ${pp.pct ?? 0}%` : "");
    });
    const offPair = bridge.lan.onPairProgress((p) => {
      const pp = p as { phase?: string; paired?: number; total?: number; last?: { label?: string; ip?: string } };
      setPairProgress({ paired: pp.paired ?? 0, total: pp.total ?? 0, last: pp.last?.label || pp.last?.ip });
    });
    return () => { offScan(); offPair(); };
  }, []);

  async function startScan() {
    setStage("scanning");
    setError(null);
    try {
      const res = await bridge.lan.scan();
      const items = (res.items as DiscoveredDevice[]) || [];
      setResult({ count: res.count, items, lan_fingerprint: res.lan_fingerprint });
      const init: Record<string, boolean> = {};
      for (const item of items) init[item.ip] = !item.is_self;
      setSelected(init);
      setStage("review");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setStage("intro");
    }
  }

  function startOwnershipVerification() {
    if (!result) return;
    setStage("ownership_verify");
    setVerifyIndex(0);
    setError(null);
    setVerified({});
  }

  async function verifyCurrentDevice() {
    if (!result) return;
    const devices = result.items.filter((d) => selected[d.ip]);
    const device = devices[verifyIndex];
    if (!device) return;

    setVerifying(true);
    setError(null);
    try {
      if (verifyMethod === "pin") {
        const challenge = await bridge.lan.startPinChallenge(device.ip);
        setCurrentPin(challenge.pin);
      } else {
        await bridge.lan.verifyMac(device.ip, verifyMac, verifySerial);
        setVerified({ ...verified, [device.ip]: true });
        setVerifyPin("");
        setVerifyMac("");
        setVerifySerial("");
        continueToNextDevice();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setVerifying(false);
    }
  }

  async function submitPinVerification() {
    if (!result) return;
    const devices = result.items.filter((d) => selected[d.ip]);
    const device = devices[verifyIndex];
    if (!device) return;

    setVerifying(true);
    setError(null);
    try {
      await bridge.lan.verifyPin(device.ip, verifyPin);
      setVerified({ ...verified, [device.ip]: true });
      setCurrentPin(null);
      setVerifyPin("");
      continueToNextDevice();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setVerifying(false);
    }
  }

  function continueToNextDevice() {
    if (!result) return;
    const devices = result.items.filter((d) => selected[d.ip]);
    if (verifyIndex + 1 < devices.length) {
      setVerifyIndex(verifyIndex + 1);
      setVerifyPin("");
      setVerifyMac("");
      setVerifySerial("");
      setCurrentPin(null);
      setVerifyMethod("pin");
    } else {
      claimAllVerified();
    }
  }

  async function claimAllVerified() {
    if (!result) return;
    setStage("claiming");
    setError(null);
    const devices = result.items.filter((d) => selected[d.ip]);
    try {
      await bridge.lan.pairAll({
        devices: devices.map((d) => ({
          ip: d.ip,
          mac: d.mac,
          hostname: d.hostname,
          vendor: d.vendor,
          device_class: d.device_class,
          label: d.label,
          randomized_mac: !!d.randomized_mac,
          lan_fingerprint: d.lan_fingerprint ?? result.lan_fingerprint ?? "unknown"
        })),
        lanFingerprint: result.lan_fingerprint ?? "unknown",
        skipRandomized,
        skipRouter
      });
      setStage("done");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setStage("review");
    }
  }

  const selectedCount = useMemo(() => {
    if (!result) return 0;
    return result.items.filter((d) => selected[d.ip]).length;
  }, [result, selected]);

  const androidCount = useMemo(() => {
    if (!result) return 0;
    return result.items.filter(looksLikeAndroid).length;
  }, [result]);

  if (stage === "intro") {
    return (
      <main className="page" data-fade>
        <header className="page-header">
          <div>
            <span className="page-header__eyebrow">Devices · LAN sweep</span>
            <h1 className="page-header__title">Sweep your LAN</h1>
            <p className="page-header__lede">
              We'll probe every device on your network using mDNS, ARP and
              SSDP, then show you a clean list to review before any pairing
              request is sent. Nothing is paired until you say go.
            </p>
          </div>
        </header>

        {error && <div className="auth-error">{error}</div>}

        <section className="wizard-intro">
          <ul className="wizard-intro__steps">
            <li><span>1</span> We discover what's on the LAN — no packets sent beyond your network.</li>
            <li><span>2</span> You review the list and uncheck anything you don't own.</li>
            <li><span>3</span> We send a one-touch claim to each device with friend-or-foe protection.</li>
            <li><span>4</span> Paired devices appear in your Devices list, agents start at next idle window.</li>
          </ul>
          <div className="wizard-actions">
            <button type="button" className="btn btn--ghost" onClick={() => nav(-1)}>Back</button>
            <button type="button" className="btn btn--primary" onClick={() => void startScan()}>
              <Wifi size={14} aria-hidden /> Start sweep
            </button>
          </div>
        </section>
      </main>
    );
  }

  if (stage === "scanning") {
    return (
      <main className="page" data-fade>
        <header className="page-header">
          <div>
            <span className="page-header__eyebrow">Sweeping…</span>
            <h1 className="page-header__title">Looking at every device on the LAN</h1>
            <p className="page-header__lede">{scanProgress || "Probing…"}</p>
          </div>
        </header>
        <div className="progress-bar"><div className="progress-bar__fill" style={{ width: "60%" }} /></div>
      </main>
    );
  }

  if (stage === "ownership_verify") {
    if (!result) return null;
    const devices = result.items.filter((d) => selected[d.ip]);
    const device = devices[verifyIndex];
    if (!device) return null;
    const progress = `${verifyIndex + 1} of ${devices.length}`;

    return (
      <main className="page" data-fade>
        <header className="page-header">
          <div>
            <span className="page-header__eyebrow">Verify ownership</span>
            <h1 className="page-header__title">{progress}: {device.label || device.hostname || device.ip}</h1>
            <p className="page-header__lede">
              Choose how to verify you own this device: display a PIN code or check MAC address
            </p>
          </div>
        </header>

        {currentPin ? (
          <section className="wizard" style={{ maxWidth: 600 }}>
            <div className="wizard-step">
              <div className="wizard-step__body">
                <span className="wizard-step__title">PIN on device display</span>
                <span className="wizard-step__lede" style={{ marginBottom: 16 }}>
                  This PIN should be visible on the device's screen or console right now.
                </span>
                <div style={{ padding: "24px 32px", background: "var(--bg-alt)", borderRadius: 8, textAlign: "center", marginBottom: 24 }}>
                  <div style={{ fontSize: 48, fontWeight: 700, letterSpacing: 4, fontFamily: "monospace", color: "var(--fg)" }}>
                    {currentPin}
                  </div>
                </div>
                <div className="field">
                  <label htmlFor="pin-input">Confirm PIN displayed on device</label>
                  <input
                    id="pin-input"
                    type="text"
                    value={verifyPin}
                    onChange={(e) => setVerifyPin(e.target.value.replace(/\D/g, "").slice(0, 6))}
                    placeholder="000000"
                    maxLength={6}
                    autoFocus
                  />
                  {error && <span style={{ color: "var(--fg-error)", fontSize: 12, marginTop: 4, display: "block" }}>{error}</span>}
                </div>
              </div>
              <div className="cluster" style={{ marginTop: 24 }}>
                <button type="button" className="btn btn--ghost" onClick={() => { setCurrentPin(null); setVerifyPin(""); setError(null); }} disabled={verifying}>
                  Cancel
                </button>
                <button
                  type="button"
                  className="btn btn--primary"
                  onClick={() => void submitPinVerification()}
                  disabled={verifyPin.length !== 6 || verifying}
                >
                  {verifying ? "Verifying…" : "Verify PIN"}
                </button>
              </div>
            </div>
          </section>
        ) : (
          <section className="wizard" style={{ maxWidth: 600 }}>
            <div className="cluster" style={{ gap: 16, marginBottom: 24 }}>
              <button
                type="button"
                className={`btn ${verifyMethod === "pin" ? "btn--primary" : "btn--ghost"}`}
                onClick={() => setVerifyMethod("pin")}
                disabled={verifying}
              >
                Display PIN code
              </button>
              <button
                type="button"
                className={`btn ${verifyMethod === "mac" ? "btn--primary" : "btn--ghost"}`}
                onClick={() => setVerifyMethod("mac")}
                disabled={verifying}
              >
                Check MAC address
              </button>
            </div>

            {verifyMethod === "pin" ? (
              <div className="wizard-step">
                <div className="wizard-step__body">
                  <span className="wizard-step__title">PIN display</span>
                  <span className="wizard-step__lede">
                    A PIN will be sent to the device. It should display on the device's screen.
                  </span>
                  <div className="cluster" style={{ marginTop: 24 }}>
                    <button
                      type="button"
                      className="btn btn--ghost"
                      onClick={() => setVerifyMethod("mac")}
                      disabled={verifying}
                    >
                      Use MAC instead
                    </button>
                    <button
                      type="button"
                      className="btn btn--primary"
                      onClick={() => void verifyCurrentDevice()}
                      disabled={verifying}
                    >
                      {verifying ? "Sending…" : "Show PIN on device"}
                    </button>
                  </div>
                </div>
              </div>
            ) : (
              <div className="wizard-step">
                <div className="wizard-step__body">
                  <span className="wizard-step__title">Check MAC address</span>
                  <span className="wizard-step__lede" style={{ marginBottom: 16 }}>
                    Enter the MAC address from the device's network settings. Usually found in:
                  </span>
                  <ul style={{ marginLeft: 24, marginBottom: 16 }}>
                    <li>Settings → About → MAC address</li>
                    <li>System → Network → Properties</li>
                    <li>Router's connected devices list</li>
                  </ul>
                  <div className="field">
                    <label htmlFor="mac-input">MAC address</label>
                    <input
                      id="mac-input"
                      type="text"
                      value={verifyMac}
                      onChange={(e) => setVerifyMac(e.target.value.toUpperCase())}
                      placeholder="AA:BB:CC:DD:EE:FF or AABBCCDDEEFF"
                      autoFocus
                    />
                    {verifyMac && !/^([0-9A-F]{2}[:-]?){5}([0-9A-F]{2})$|^[0-9A-F]{12}$/.test(verifyMac) && (
                      <span style={{ color: "var(--fg-warn)", fontSize: 12, marginTop: 4, display: "block" }}>
                        Format: AA:BB:CC:DD:EE:FF or AABBCCDDEEFF
                      </span>
                    )}
                    {error && error.toLowerCase().includes("mac") && (
                      <span style={{ color: "var(--fg-error)", fontSize: 12, marginTop: 4, display: "block" }}>{error}</span>
                    )}
                  </div>
                  <div className="field">
                    <label htmlFor="serial-input">Serial number (optional)</label>
                    <input
                      id="serial-input"
                      type="text"
                      value={verifySerial}
                      onChange={(e) => setVerifySerial(e.target.value)}
                      placeholder="Leave blank if unknown"
                    />
                  </div>
                  <div className="cluster" style={{ marginTop: 24 }}>
                    <button
                      type="button"
                      className="btn btn--ghost"
                      onClick={() => setVerifyMethod("pin")}
                      disabled={verifying}
                    >
                      Use PIN instead
                    </button>
                    <button
                      type="button"
                      className="btn btn--primary"
                      onClick={() => void verifyCurrentDevice()}
                      disabled={!verifyMac || !/^([0-9A-F]{2}[:-]?){5}([0-9A-F]{2})$|^[0-9A-F]{12}$/.test(verifyMac) || verifying}
                    >
                      {verifying ? "Verifying…" : "Verify MAC"}
                    </button>
                  </div>
                </div>
              </div>
            )}
          </section>
        )}
      </main>
    );
  }

  if (stage === "claiming") {
    const pct = pairProgress.total > 0 ? Math.round((pairProgress.paired / pairProgress.total) * 100) : 0;
    return (
      <main className="page" data-fade>
        <header className="page-header">
          <div>
            <span className="page-header__eyebrow">Claiming…</span>
            <h1 className="page-header__title">{pairProgress.paired} of {pairProgress.total} claimed</h1>
            <p className="page-header__lede">{pairProgress.last ? `Last: ${pairProgress.last}` : "Sending claim requests…"}</p>
          </div>
        </header>
        <div className="progress-bar"><div className="progress-bar__fill" style={{ width: `${pct}%` }} /></div>
      </main>
    );
  }

  if (stage === "done") {
    return (
      <main className="page" data-fade>
        <header className="page-header">
          <div>
            <span className="page-header__eyebrow">Done</span>
            <h1 className="page-header__title">{pairProgress.paired} devices claimed</h1>
            <p className="page-header__lede">They'll appear in your Devices list as soon as they ack the claim.</p>
          </div>
          <div className="page-header__actions">
            <button type="button" className="btn btn--primary" onClick={() => nav("/devices")}>See devices</button>
          </div>
        </header>
        {androidCount > 0 && (
          <section className="callout">
            <div className="callout__icon"><Smartphone size={18} aria-hidden /></div>
            <div className="callout__body">
              <strong>{androidCount} Android-like device{androidCount === 1 ? "" : "s"} on this LAN.</strong>
              <span>
                Sweep can't pair phones over standard claim — Android needs the Wireless
                Debugging flow with a 6-digit PIN. Enable it on the phone, then run the
                Android pairing wizard from your Devices page.
              </span>
              <div className="cluster" style={{ marginTop: 8 }}>
                <button type="button" className="btn btn--quiet btn--sm" onClick={() => nav("/devices/android")}>
                  <Smartphone size={13} aria-hidden /> Open Android pairing
                </button>
              </div>
            </div>
          </section>
        )}
      </main>
    );
  }

  return (
    <main className="page" data-fade>
      <header className="page-header">
        <div>
          <span className="page-header__eyebrow">Review · LAN sweep</span>
          <h1 className="page-header__title">Found {result?.items.length ?? 0} devices on your LAN</h1>
          <p className="page-header__lede">
            Uncheck anything you don't own. We've already marked anything that
            looks like the machine you're running on as self.
          </p>
        </div>
        <div className="page-header__actions">
          <button type="button" className="btn btn--ghost" onClick={() => setStage("intro")}>Re-scan</button>
          <button
            type="button"
            className="btn btn--primary"
            disabled={selectedCount === 0}
            onClick={() => startOwnershipVerification()}
          >
            <Plug size={14} aria-hidden /> Verify ownership {selectedCount > 0 && `(${selectedCount} device${selectedCount === 1 ? "" : "s"})`}
          </button>
        </div>
      </header>

      <div className="cluster">
        <label className="cluster">
          <input type="checkbox" checked={skipRandomized} onChange={(e) => setSkipRandomized(e.target.checked)} />
          Skip randomized MACs (Android privacy mode)
        </label>
        <label className="cluster">
          <input type="checkbox" checked={skipRouter} onChange={(e) => setSkipRouter(e.target.checked)} />
          Skip router / gateway
        </label>
      </div>

      {androidCount > 0 && (
        <section className="callout">
          <div className="callout__icon"><Smartphone size={18} aria-hidden /></div>
          <div className="callout__body">
            <strong>{androidCount} Android-like device{androidCount === 1 ? "" : "s"} detected.</strong>
            <span>
              Phones can't pair via the standard sweep — Android 11+ needs Wireless
              Debugging + a 6-digit PIN. Finish this sweep, then open Android pairing
              from your Devices page to enroll them properly.
            </span>
            <div className="cluster" style={{ marginTop: 8 }}>
              <button type="button" className="btn btn--quiet btn--sm" onClick={() => nav("/devices/android")}>
                <Smartphone size={13} aria-hidden /> Open Android pairing
              </button>
            </div>
          </div>
        </section>
      )}

      {!result?.items.length ? (
        <EmptyState
          title="Nothing on this LAN looked claimable"
          body="Make sure you're on Wi-Fi, not a guest VLAN. Then try sweep again."
          cta={<button type="button" className="btn btn--primary" onClick={() => setStage("intro")}>Try again</button>}
        />
      ) : (
        <table className="t-table">
          <thead>
            <tr>
              <th />
              <th>Device</th>
              <th>Class</th>
              <th>IP / MAC</th>
              <th>Vendor</th>
              <th>Seen</th>
              <th>Notes</th>
            </tr>
          </thead>
          <tbody>
            {result.items.map((d) => (
              <tr key={d.ip}>
                <td>
                  <input
                    type="checkbox"
                    disabled={d.is_self}
                    checked={Boolean(selected[d.ip])}
                    onChange={(e) => setSelected((s) => ({ ...s, [d.ip]: e.target.checked }))}
                  />
                </td>
                <td><strong>{d.label || d.hostname || d.ip}</strong></td>
                <td><StatusPill tone="quiet" withDot={false}>{d.device_class}</StatusPill></td>
                <td className="mono">{d.ip}<br />{d.mac}</td>
                <td>{d.vendor || "—"}</td>
                <td>{formatRelative(d.last_seen_at)}</td>
                <td>
                  {d.is_self && <StatusPill tone="warn">self</StatusPill>}
                  {d.randomized_mac && <StatusPill tone="quiet">randomized</StatusPill>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </main>
  );
}
