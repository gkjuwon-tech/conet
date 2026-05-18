import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Wifi, Plug, Smartphone } from "lucide-react";
import { bridge, type OwnershipMethod } from "../api/bridge";
import { StatusPill } from "../components/StatusPill";
import { EmptyState } from "../components/EmptyState";
import { OwnershipChallenge } from "../components/OwnershipChallenge";
import { formatRelative } from "../lib/format";

/**
 * Pick which verification methods are sensible for a given device.
 *
 * The PIN flow ("read a 6-digit code off the device's browser") only
 * makes sense for things that *have* a browser — TVs, fridges with
 * touch panels, IoT consoles, computers, phones. Routers, smart bulbs,
 * sensors and the rest of the "headless" world don't have a screen we
 * can paint a PIN on, so we drop pin_display entirely and force the
 * user down the MAC-from-settings path. signed_attestation stays in
 * the future-work bucket; we don't surface it from the sweep wizard
 * yet because no LAN-discovered device advertises its agent keys.
 */
const HEADLESS_CLASSES = new Set<string>([
  "router",
  "gateway",
  "iot", // Hue bulbs, Sonos speakers, smart plugs — no usable screen
]);

function methodsForDeviceClass(deviceClass: string | undefined): OwnershipMethod[] {
  const cls = (deviceClass || "").toLowerCase();
  if (HEADLESS_CLASSES.has(cls)) return ["mac_serial"];
  return ["pin_display", "mac_serial"];
}

function looksLikeAndroid(d: {
  device_class?: string;
  vendor?: string;
  randomized_mac?: boolean;
  label?: string;
  hostname?: string | null;
}): boolean {
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

export function LanWizard() {
  const nav = useNavigate();
  const [stage, setStage] = useState<Stage>("intro");
  const [scanProgress, setScanProgress] = useState<string>("");
  const [scanPct, setScanPct] = useState<number>(0);
  const [pairProgress, setPairProgress] = useState<{ paired: number; total: number; last?: string }>({
    paired: 0,
    total: 0
  });
  const [result, setResult] = useState<ScanResult | null>(null);
  const [selected, setSelected] = useState<Record<string, boolean>>({});
  const [skipRandomized, setSkipRandomized] = useState(true);
  const [skipRouter, setSkipRouter] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Ownership-verification cursor. We walk through the user-selected
  // devices one at a time; the OwnershipChallenge child component owns
  // the full sub-state-machine (request → respond → verified).
  const [verifyIndex, setVerifyIndex] = useState(0);
  const [verifiedIds, setVerifiedIds] = useState<Record<string, string>>({});

  useEffect(() => {
    const offScan = bridge.lan.onScanProgress((p) => {
      const pp = p as { phase?: string; pct?: number; detail?: string };
      const pct = Math.max(0, Math.min(100, pp.pct ?? 0));
      setScanPct(pct);
      const phase = pp.phase ?? "scanning";
      const detail = pp.detail ?? "";
      setScanProgress(detail ? `${phase} · ${detail}` : `${phase} · ${pct}%`);
    });
    const offPair = bridge.lan.onPairProgress((p) => {
      const pp = p as { phase?: string; paired?: number; total?: number; last?: { label?: string; ip?: string } };
      setPairProgress({
        paired: pp.paired ?? 0,
        total: pp.total ?? 0,
        last: pp.last?.label || pp.last?.ip
      });
    });
    return () => {
      offScan();
      offPair();
    };
  }, []);

  const selectedDevices = useMemo(() => {
    if (!result) return [];
    return result.items.filter((d) => selected[d.ip]);
  }, [result, selected]);

  const selectedCount = selectedDevices.length;

  const androidCount = useMemo(() => {
    if (!result) return 0;
    return result.items.filter(looksLikeAndroid).length;
  }, [result]);

  async function startScan() {
    setStage("scanning");
    setScanPct(0);
    setScanProgress("");
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
    setVerifiedIds({});
    setError(null);
  }

  function handleVerified(deviceIp: string, challengeId: string) {
    setVerifiedIds((prev) => ({ ...prev, [deviceIp]: challengeId }));
    if (verifyIndex + 1 < selectedDevices.length) {
      setVerifyIndex(verifyIndex + 1);
    } else {
      void claimAllVerified();
    }
  }

  async function claimAllVerified() {
    if (!result) return;
    setStage("claiming");
    setError(null);
    try {
      await bridge.lan.pairAll({
        devices: selectedDevices.map((d) => ({
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

  if (stage === "intro") {
    return (
      <main className="page" data-fade>
        <header className="page-header">
          <div>
            <span className="page-header__eyebrow">Devices · LAN sweep</span>
            <h1 className="page-header__title">Sweep your LAN</h1>
            <p className="page-header__lede">
              We'll probe every device on your network using mDNS, ARP and SSDP,
              then show you a clean list to review before any pairing request
              is sent. Nothing is paired until you say go.
            </p>
          </div>
        </header>

        {error && <div className="auth-error">{error}</div>}

        <section className="wizard-intro">
          <ul className="wizard-intro__steps">
            <li><span>1</span> We discover what's on the LAN — no packets sent beyond your network.</li>
            <li><span>2</span> You review the list and uncheck anything you don't own.</li>
            <li><span>3</span> You prove ownership of each device — PIN on its screen, or MAC from its settings.</li>
            <li><span>4</span> We send a one-touch claim, then agents start at the next idle window.</li>
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
        <div className="progress-bar"><div className="progress-bar__fill" style={{ width: `${Math.max(4, scanPct)}%` }} /></div>
      </main>
    );
  }

  if (stage === "ownership_verify") {
    if (!result) return null;
    const device = selectedDevices[verifyIndex];
    if (!device) return null;

    return (
      <main className="page" data-fade>
        <header className="page-header">
          <div>
            <span className="page-header__eyebrow">
              Verify ownership · {verifyIndex + 1} / {selectedDevices.length}
            </span>
            <h1 className="page-header__title">Prove these devices are yours</h1>
            <p className="page-header__lede">
              We won't claim anything until you verify each device. The
              verification doesn't leave your network — it's a proof you can
              read the device's PIN off the screen, or its MAC from settings.
            </p>
          </div>
        </header>

        <OwnershipChallenge
          key={device.ip}
          device={{
            ip: device.ip,
            label: device.label || device.hostname || device.ip,
            mac: device.mac
          }}
          methods={methodsForDeviceClass(device.device_class)}
          progressLabel={`Device ${verifyIndex + 1} of ${selectedDevices.length}`}
          onVerified={(challengeId) => handleVerified(device.ip, challengeId)}
          onCancel={() => setStage("review")}
        />
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
    const verifiedCount = Object.keys(verifiedIds).length;
    return (
      <main className="page" data-fade>
        <header className="page-header">
          <div>
            <span className="page-header__eyebrow">Done</span>
            <h1 className="page-header__title">
              {pairProgress.paired || verifiedCount} devices claimed
            </h1>
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
                Sweep can't pair phones over standard claim — Android needs the
                Wireless Debugging flow with a 6-digit PIN. Enable it on the
                phone, then run the Android pairing wizard from your Devices page.
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

      {error && <div className="auth-error">{error}</div>}

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
              Phones can't pair via the standard sweep — Android 11+ needs
              Wireless Debugging + a 6-digit PIN. Finish this sweep, then open
              Android pairing from your Devices page to enroll them properly.
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
