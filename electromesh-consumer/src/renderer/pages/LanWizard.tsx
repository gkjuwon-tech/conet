import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Wifi, Plug } from "lucide-react";
import { bridge } from "../api/bridge";
import { StatusPill } from "../components/StatusPill";
import { EmptyState } from "../components/EmptyState";
import { formatRelative } from "../lib/format";

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

type Stage = "intro" | "scanning" | "review" | "pairing" | "done";

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

  async function pairSelected() {
    if (!result) return;
    setStage("pairing");
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

  if (stage === "pairing") {
    const pct = pairProgress.total > 0 ? Math.round((pairProgress.paired / pairProgress.total) * 100) : 0;
    return (
      <main className="page" data-fade>
        <header className="page-header">
          <div>
            <span className="page-header__eyebrow">Pairing…</span>
            <h1 className="page-header__title">{pairProgress.paired} of {pairProgress.total} paired</h1>
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
            <h1 className="page-header__title">{pairProgress.paired} devices paired</h1>
            <p className="page-header__lede">They'll appear in your Devices list as soon as they ack the claim.</p>
          </div>
          <div className="page-header__actions">
            <button type="button" className="btn btn--primary" onClick={() => nav("/devices")}>See devices</button>
          </div>
        </header>
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
            onClick={() => void pairSelected()}
          >
            <Plug size={14} aria-hidden /> Pair {selectedCount} device{selectedCount === 1 ? "" : "s"}
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
