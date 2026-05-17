import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Smartphone, ShieldAlert, Search, BadgeCheck } from "lucide-react";
import { bridge } from "../api/bridge";
import { StatusPill } from "../components/StatusPill";
import { EmptyState } from "../components/EmptyState";
import { formatRelative } from "../lib/format";

interface AndroidStatus {
  adb_available: boolean;
  adb_version?: string;
  total_scans?: number;
  total_paired?: number;
  friends_count?: number;
  vetoed_count?: number;
  friends?: Array<{ ip: string; mac?: string; label?: string; added_at?: string }>;
  vetoed?: Array<{ ip: string; reason?: string; added_at?: string }>;
}

interface AndroidCandidate {
  ip: string;
  port?: number;
  pair_port?: number;
  service?: string;
  model?: string;
  brand?: string;
  manufacturer?: string;
  sdk?: number;
  abi?: string;
  device_class?: string;
  is_emulator?: boolean;
  randomized_mac?: boolean;
  reachable?: boolean;
  last_seen_at?: string;
}

interface DiscoverResponse {
  candidates: AndroidCandidate[];
  scan_duration_ms?: number;
  scan_id?: string;
}

type Stage = "status" | "discover" | "enroll" | "done";

export function AndroidPairing() {
  const nav = useNavigate();
  const [stage, setStage] = useState<Stage>("status");
  const [status, setStatus] = useState<AndroidStatus | null>(null);
  const [candidates, setCandidates] = useState<AndroidCandidate[]>([]);
  const [selectedIps, setSelectedIps] = useState<Set<string>>(new Set());
  const [pins, setPins] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [friendIp, setFriendIp] = useState("");
  const [friendLabel, setFriendLabel] = useState("");
  const [enrollResults, setEnrollResults] = useState<Array<{ ip: string; ok: boolean; message?: string }>>([]);

  useEffect(() => { void refresh(); }, []);

  async function refresh() {
    setBusy(true); setError(null);
    try {
      const s = await bridge.android.status();
      setStatus(s as AndroidStatus);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally { setBusy(false); }
  }

  async function discover() {
    setStage("discover"); setBusy(true); setError(null); setCandidates([]);
    try {
      const res = await bridge.android.discover({ window_seconds: 6 });
      const r = res as DiscoverResponse;
      setCandidates(r.candidates || []);
      const next = new Set<string>();
      for (const c of (r.candidates || [])) if (c.reachable !== false) next.add(c.ip);
      setSelectedIps(next);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally { setBusy(false); }
  }

  async function enrollAll() {
    setBusy(true); setError(null);
    const targets = candidates.filter((c) => selectedIps.has(c.ip));
    try {
      const payload = {
        targets: targets.map((c) => ({
          ip: c.ip,
          pair_port: c.pair_port,
          connect_port: c.port,
          pin: pins[c.ip] || null
        }))
      };
      const res = await bridge.android.enrollMany(payload);
      const r = res as { results?: Array<{ ip: string; ok: boolean; message?: string }> };
      setEnrollResults(r.results || []);
      setStage("done");
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally { setBusy(false); }
  }

  async function addFriend() {
    if (!friendIp.trim()) return;
    setBusy(true); setError(null);
    try {
      await bridge.android.addFriend({ ip: friendIp.trim(), label: friendLabel.trim() || undefined });
      setFriendIp(""); setFriendLabel("");
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally { setBusy(false); }
  }

  async function vetoIp(ip: string) {
    setBusy(true); setError(null);
    try {
      await bridge.android.vetoIp(ip);
      setCandidates((cs) => cs.filter((c) => c.ip !== ip));
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally { setBusy(false); }
  }

  return (
    <main className="page" data-fade>
      <header className="page-header">
        <div>
          <span className="page-header__eyebrow">Devices · Android pairing</span>
          <h1 className="page-header__title">Pair an Android phone or tablet</h1>
          <p className="page-header__lede">
            Use Wireless Debugging to enroll Android 11+ devices over the LAN —
            no app store, no sideload. The phone shows a 6-digit PIN; type it
            here and we pair over TLS.
          </p>
        </div>
        <div className="page-header__actions">
          <button type="button" className="btn btn--ghost" onClick={() => nav(-1)}>Back</button>
          <button type="button" className="btn btn--primary" disabled={busy} onClick={() => void discover()}>
            <Search size={14} aria-hidden /> {busy && stage === "discover" ? "Scanning…" : "Scan LAN"}
          </button>
        </div>
      </header>

      {error && <div className="auth-error">{error}</div>}

      <section className="kpi-strip">
        <div className="kpi">
          <span className="kpi__label">adb available</span>
          <span className="kpi__value">{status?.adb_available ? "Yes" : "No"}</span>
          <span className="kpi__hint">{status?.adb_version ?? "—"}</span>
        </div>
        <div className="kpi">
          <span className="kpi__label">Total scans</span>
          <span className="kpi__value">{status?.total_scans ?? 0}</span>
          <span className="kpi__hint">Lifetime</span>
        </div>
        <div className="kpi">
          <span className="kpi__label">Paired</span>
          <span className="kpi__value">{status?.total_paired ?? 0}</span>
          <span className="kpi__hint">via this console</span>
        </div>
        <div className="kpi">
          <span className="kpi__label">Friends · Vetoed</span>
          <span className="kpi__value">{status?.friends_count ?? 0} · {status?.vetoed_count ?? 0}</span>
          <span className="kpi__hint">Allowlist / blocklist</span>
        </div>
      </section>

      {!status?.adb_available && (
        <section className="callout">
          <div className="callout__icon"><ShieldAlert size={18} aria-hidden /></div>
          <div className="callout__body">
            <strong>adb not detected on the host.</strong>
            <span>
              Install Android platform tools on this machine, then re-open this
              page. See <em>backend/docs/ANDROID_PAIRING_GUIDE_KO.md</em> for
              one-line install commands.
            </span>
          </div>
        </section>
      )}

      <section className="section">
        <div className="section__head">
          <h2>Friends (allowlist)</h2>
          <span className="rule" />
          <span className="right">These IPs are exempt from auto-pair.</span>
        </div>
        <div className="cluster" style={{ marginBottom: 12 }}>
          <input
            className="input"
            placeholder="IP (e.g. 192.168.1.42)"
            value={friendIp}
            onChange={(e) => setFriendIp(e.target.value)}
            style={{ minWidth: 200 }}
          />
          <input
            className="input"
            placeholder="Label (e.g. My iPhone)"
            value={friendLabel}
            onChange={(e) => setFriendLabel(e.target.value)}
            style={{ minWidth: 200 }}
          />
          <button type="button" className="btn btn--quiet" onClick={() => void addFriend()} disabled={busy || !friendIp.trim()}>
            Add friend
          </button>
        </div>
        {!status?.friends || status.friends.length === 0 ? (
          <p className="lede mute">No friends yet — add your phone's IP so we don't try to pair it.</p>
        ) : (
          <table className="t-table">
            <thead>
              <tr><th>IP</th><th>Label</th><th>Added</th></tr>
            </thead>
            <tbody>
              {status.friends.map((f) => (
                <tr key={f.ip}>
                  <td className="mono">{f.ip}</td>
                  <td>{f.label || "—"}</td>
                  <td>{formatRelative(f.added_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section className="section">
        <div className="section__head">
          <h2>Candidates {stage === "discover" && busy ? "(scanning…)" : ""}</h2>
          <span className="rule" />
          <span className="right">{candidates.length} found</span>
        </div>

        {candidates.length === 0 ? (
          <EmptyState
            title={busy ? "Scanning the LAN for Android phones…" : "No Android devices visible yet"}
            body="Make sure Wireless Debugging is enabled on the phone and that it's on the same Wi-Fi as this computer."
            cta={
              !busy && (
                <button type="button" className="btn btn--primary" onClick={() => void discover()}>
                  <Smartphone size={14} aria-hidden /> Scan again
                </button>
              )
            }
          />
        ) : (
          <div className="android-grid">
            {candidates.map((c) => (
              <article key={c.ip} className="android-card">
                <header className="android-card__head">
                  <div>
                    <strong>{c.brand || c.manufacturer || "Android"} {c.model || ""}</strong>
                    <span className="mono">{c.ip}{c.port ? `:${c.port}` : ""}</span>
                  </div>
                  <div className="cluster">
                    {c.is_emulator && <StatusPill tone="warn">emulator?</StatusPill>}
                    {c.reachable === false && <StatusPill tone="quiet">unreachable</StatusPill>}
                    {c.device_class && <StatusPill tone="quiet" withDot={false}>{c.device_class}</StatusPill>}
                  </div>
                </header>

                <dl className="android-card__meta">
                  <div><dt>SDK</dt><dd>{c.sdk ?? "—"}</dd></div>
                  <div><dt>ABI</dt><dd>{c.abi ?? "—"}</dd></div>
                  <div><dt>Service</dt><dd className="mono">{c.service?.replace(/_/g, " ") ?? "—"}</dd></div>
                  <div><dt>Last seen</dt><dd>{formatRelative(c.last_seen_at)}</dd></div>
                </dl>

                <div className="cluster" style={{ marginTop: 12 }}>
                  <label className="cluster" style={{ marginRight: "auto" }}>
                    <input
                      type="checkbox"
                      checked={selectedIps.has(c.ip)}
                      onChange={(e) => {
                        setSelectedIps((s) => {
                          const next = new Set(s);
                          if (e.target.checked) next.add(c.ip);
                          else next.delete(c.ip);
                          return next;
                        });
                      }}
                    />
                    Enroll
                  </label>
                  <button type="button" className="btn btn--quiet btn--sm" onClick={() => void vetoIp(c.ip)}>
                    Veto
                  </button>
                </div>

                <div className="field" style={{ marginTop: 8 }}>
                  <label htmlFor={`pin-${c.ip}`}>PIN from phone</label>
                  <input
                    id={`pin-${c.ip}`}
                    inputMode="numeric"
                    pattern="[0-9]*"
                    maxLength={6}
                    placeholder="6 digits"
                    value={pins[c.ip] || ""}
                    onChange={(e) => setPins((p) => ({ ...p, [c.ip]: e.target.value.replace(/\D/g, "").slice(0, 6) }))}
                  />
                </div>
              </article>
            ))}
          </div>
        )}

        {candidates.length > 0 && (
          <div className="wizard-actions">
            <span className="wizard-actions__hint">
              {selectedIps.size} selected
            </span>
            <button
              type="button"
              className="btn btn--primary"
              disabled={busy || selectedIps.size === 0}
              onClick={() => void enrollAll()}
            >
              <BadgeCheck size={14} aria-hidden /> Pair {selectedIps.size} device{selectedIps.size === 1 ? "" : "s"}
            </button>
          </div>
        )}
      </section>

      {stage === "done" && enrollResults.length > 0 && (
        <section className="section">
          <div className="section__head">
            <h2>Pairing results</h2>
            <span className="rule" />
            <span className="right">{enrollResults.filter((r) => r.ok).length} of {enrollResults.length} succeeded</span>
          </div>
          <table className="t-table">
            <thead>
              <tr><th>IP</th><th>Status</th><th>Message</th></tr>
            </thead>
            <tbody>
              {enrollResults.map((r) => (
                <tr key={r.ip}>
                  <td className="mono">{r.ip}</td>
                  <td><StatusPill tone={r.ok ? "ok" : "danger"}>{r.ok ? "paired" : "failed"}</StatusPill></td>
                  <td>{r.message || (r.ok ? "Device is online" : "Unknown error")}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}
    </main>
  );
}
