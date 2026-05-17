/* -------------------------------------------------------------------------
 * Android pairing v2 — UI surface for the backend /v1/android/* endpoints
 * shipped in PR #1. Walks the user through:
 *
 *   1. Status check     → does the host actually have adb? Any friends?
 *   2. mDNS discovery   → which Android handsets are advertising
 *                         _adb-tls-pairing._tcp.local. on this LAN?
 *   3. Enroll           → adb pair <ip>:<port> <PIN>  (or legacy connect)
 *
 * Self-defense: the backend FriendOrFoe filter skips devices that match
 * the operator's saved friend records, so the user can register their
 * personal phone first and not accidentally adopt it as a worker.
 * ------------------------------------------------------------------------- */

import { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  AlertTriangle,
  CheckCircle2,
  Loader2,
  Plus,
  Radar,
  ShieldOff,
  Smartphone,
  Tv2,
  Tablet,
  Watch
} from "lucide-react";
import { PageHeader } from "../components/PageHeader";
import { bridge } from "../api/bridge";

interface AndroidStatus {
  adb_available: boolean;
  adb_version: string | null;
  friends: Array<{
    ip?: string | null;
    mac?: string | null;
    label?: string | null;
  }>;
  vetoed_ips: string[];
  stats: { discovered: number; paired: number; failed: number };
}

interface AndroidOffer {
  ip: string;
  port: number;
  mac: string | null;
  hostname: string | null;
  device_class: "phone" | "tablet" | "tv" | "watch" | "android";
  vendor: string | null;
  model: string | null;
  brand: string | null;
  sdk: number | null;
  abi: string | null;
  emulator_suspected: boolean;
  pairing_kind: "tls_pair" | "tls_connect" | "legacy_connect";
  service_name?: string | null;
  hint?: string | null;
}

interface DiscoverResult {
  offers: AndroidOffer[];
  scanned_at: string | null;
  duration_seconds: number;
}

interface EnrollResult {
  ok: boolean;
  ip: string;
  port: number;
  device_id?: string | null;
  label?: string | null;
  serial?: string | null;
  brand?: string | null;
  model?: string | null;
  android_release?: string | null;
  sdk?: number | null;
  error?: string | null;
}

type Stage = "intro" | "scanning" | "results" | "enrolling" | "done";

const CLASS_ICON = {
  phone: Smartphone,
  tablet: Tablet,
  tv: Tv2,
  watch: Watch,
  android: Smartphone
} as const;

export function AndroidPairing() {
  const nav = useNavigate();
  const [status, setStatus] = useState<AndroidStatus | null>(null);
  const [statusErr, setStatusErr] = useState<string | null>(null);
  const [stage, setStage] = useState<Stage>("intro");
  const [scanErr, setScanErr] = useState<string | null>(null);
  const [offers, setOffers] = useState<AndroidOffer[]>([]);
  const [selected, setSelected] = useState<Record<string, boolean>>({});
  const [pins, setPins] = useState<Record<string, string>>({});
  const [results, setResults] = useState<EnrollResult[]>([]);
  const [friendIp, setFriendIp] = useState("");
  const [friendLabel, setFriendLabel] = useState("");
  const [friendBusy, setFriendBusy] = useState(false);

  const refreshStatus = useCallback(async () => {
    setStatusErr(null);
    const res = await bridge.android.status();
    if (!res.ok) {
      setStatusErr(res.error ?? "android status failed");
      setStatus(null);
      return;
    }
    setStatus(res.status as AndroidStatus);
  }, []);

  useEffect(() => {
    void refreshStatus();
  }, [refreshStatus]);

  async function runDiscovery() {
    setStage("scanning");
    setScanErr(null);
    setOffers([]);
    const res = await bridge.android.discover({ window_seconds: 8 });
    if (!res.ok) {
      setScanErr(res.error ?? "discovery failed");
      setStage("intro");
      return;
    }
    const result = res.result as DiscoverResult;
    setOffers(result.offers);
    setStage("results");
  }

  async function addFriend() {
    const ip = friendIp.trim();
    if (!ip) return;
    setFriendBusy(true);
    const res = await bridge.android.addFriend({
      ip,
      label: friendLabel.trim() || undefined
    });
    setFriendBusy(false);
    if (res.ok) {
      setStatus(res.status as AndroidStatus);
      setFriendIp("");
      setFriendLabel("");
    } else {
      setStatusErr(res.error ?? "could not save friend");
    }
  }

  async function vetoOffer(offer: AndroidOffer) {
    const res = await bridge.android.vetoIp(offer.ip);
    if (res.ok) {
      setStatus(res.status as AndroidStatus);
      setOffers((prev) => prev.filter((o) => o.ip !== offer.ip));
      setSelected((prev) => {
        const next = { ...prev };
        delete next[offer.ip];
        return next;
      });
    } else {
      setStatusErr(res.error ?? "veto failed");
    }
  }

  async function enrollSelected() {
    const chosen = offers.filter((o) => selected[o.ip]);
    if (!chosen.length) return;
    setStage("enrolling");
    const payload = {
      offers: chosen.map((o) => ({
        ip: o.ip,
        port: o.port,
        pairing_kind: o.pairing_kind,
        pin: pins[o.ip]?.trim() || null,
        label:
          o.brand || o.model
            ? `${o.brand ?? ""} ${o.model ?? ""}`.trim()
            : o.hostname ?? `Android ${o.ip}`
      }))
    };
    const res = await bridge.android.enrollMany(payload);
    if (!res.ok) {
      setScanErr(res.error ?? "enrollment failed");
      setStage("results");
      return;
    }
    const data = res.result as { results: EnrollResult[] };
    setResults(data.results);
    setStage("done");
    void refreshStatus();
  }

  return (
    <div className="p-8 max-w-4xl mx-auto">
      <PageHeader
        title="Android pairing"
        subtitle="Sweep your LAN for Android handsets, tablets, and TVs that have wireless debugging enabled. Your saved 'friend' devices are skipped automatically."
        action={
          <button className="em-btn-ghost" onClick={() => nav("/devices")}>
            Back to devices
          </button>
        }
      />

      <StatusBlock
        status={status}
        error={statusErr}
        onRetry={() => void refreshStatus()}
      />

      <FriendsBlock
        status={status}
        friendIp={friendIp}
        friendLabel={friendLabel}
        friendBusy={friendBusy}
        onFriendIpChange={setFriendIp}
        onFriendLabelChange={setFriendLabel}
        onAddFriend={() => void addFriend()}
      />

      {stage === "intro" && (
        <section className="em-card p-8 mb-6 text-center">
          <Radar className="mx-auto w-12 h-12 text-ink-secondary mb-4" />
          <div className="text-xl font-semibold mb-2">
            Scan this Wi-Fi for Android offers
          </div>
          <p className="text-sm text-ink-secondary mb-6 max-w-md mx-auto leading-relaxed">
            Enable <b>Settings → Developer options → Wireless debugging</b> on
            each Android device, then tap "Pair device with pairing code". Once
            the device is broadcasting the mDNS service, this button will pick
            it up.
          </p>
          {scanErr && (
            <div className="text-xs text-danger-500 mb-3 max-w-md mx-auto">
              {scanErr}
            </div>
          )}
          <button
            className="em-btn-primary"
            disabled={!status?.adb_available}
            onClick={() => void runDiscovery()}
          >
            <Radar className="w-4 h-4" />
            Sweep LAN
          </button>
          {!status?.adb_available && (
            <div className="mt-4 text-xs text-ink-secondary">
              adb is not detected on the backend host yet. Follow the{" "}
              <code className="bg-bg-elev px-1.5 py-0.5 rounded">
                ANDROID_PAIRING_GUIDE_KO.md
              </code>{" "}
              install steps and click "Refresh" above.
            </div>
          )}
        </section>
      )}

      {stage === "scanning" && (
        <section className="em-card p-8 mb-6 text-center">
          <Loader2 className="mx-auto w-10 h-10 animate-spin text-brand-500 mb-3" />
          <div className="font-medium">Listening for Android offers…</div>
          <div className="text-xs text-ink-secondary mt-2">
            mDNS sweep runs for up to ~8 seconds. PIN prompts on the phones
            will time out after about 60 seconds — keep them on-screen.
          </div>
        </section>
      )}

      {stage === "results" && (
        <ResultsBlock
          offers={offers}
          selected={selected}
          pins={pins}
          onToggle={(ip) =>
            setSelected((prev) => ({ ...prev, [ip]: !prev[ip] }))
          }
          onPinChange={(ip, v) => setPins((prev) => ({ ...prev, [ip]: v }))}
          onVeto={(o) => void vetoOffer(o)}
          onEnroll={() => void enrollSelected()}
          onRescan={() => void runDiscovery()}
          scanErr={scanErr}
        />
      )}

      {stage === "enrolling" && (
        <section className="em-card p-8 mb-6 text-center">
          <Loader2 className="mx-auto w-10 h-10 animate-spin text-brand-500 mb-3" />
          <div className="font-medium">Pairing…</div>
          <div className="text-xs text-ink-secondary mt-2 leading-relaxed">
            <code className="bg-bg-elev px-1.5 py-0.5 rounded">
              adb pair &lt;ip&gt;:&lt;port&gt; &lt;PIN&gt;
            </code>{" "}
            is being run on the backend host with jittered exponential
            backoff. This can take up to ~30 seconds per device.
          </div>
        </section>
      )}

      {stage === "done" && (
        <DoneBlock results={results} onRescan={() => void runDiscovery()} />
      )}
    </div>
  );
}

function StatusBlock({
  status,
  error,
  onRetry
}: {
  status: AndroidStatus | null;
  error: string | null;
  onRetry: () => void;
}) {
  return (
    <section className="em-card p-5 mb-4">
      <div className="flex items-start justify-between gap-4">
        <div>
          <div className="em-eyebrow mb-1">Backend status</div>
          {status ? (
            <div className="text-sm">
              {status.adb_available ? (
                <span className="text-brand-500 font-medium">
                  adb {status.adb_version ?? "available"}
                </span>
              ) : (
                <span className="text-danger-500 font-medium">
                  adb not detected
                </span>
              )}
              <span className="text-ink-secondary ml-3">
                {status.stats.discovered} discovered · {status.stats.paired}{" "}
                paired · {status.stats.failed} failed ·{" "}
                {status.friends.length} friends · {status.vetoed_ips.length}{" "}
                vetoed
              </span>
            </div>
          ) : (
            <div className="text-sm text-ink-secondary">loading…</div>
          )}
          {error && (
            <div className="text-xs text-danger-500 mt-2">{error}</div>
          )}
        </div>
        <button className="em-btn-ghost" onClick={onRetry}>
          Refresh
        </button>
      </div>
    </section>
  );
}

function FriendsBlock({
  status,
  friendIp,
  friendLabel,
  friendBusy,
  onFriendIpChange,
  onFriendLabelChange,
  onAddFriend
}: {
  status: AndroidStatus | null;
  friendIp: string;
  friendLabel: string;
  friendBusy: boolean;
  onFriendIpChange: (v: string) => void;
  onFriendLabelChange: (v: string) => void;
  onAddFriend: () => void;
}) {
  return (
    <section className="em-card p-5 mb-6">
      <div className="em-eyebrow mb-2">Friends (won't be auto-paired)</div>
      <div className="text-xs text-ink-secondary mb-3 leading-relaxed">
        Add your own phone here <b>before</b> running the sweep — the
        FriendOrFoe filter will then refuse to enroll it even if it shows up on
        mDNS.
      </div>

      {status && status.friends.length > 0 && (
        <ul className="text-xs space-y-1 mb-3">
          {status.friends.map((f, i) => (
            <li key={i} className="font-mono text-ink-secondary">
              · {f.label ?? "unnamed"} —{" "}
              <span className="text-ink-primary">
                {f.ip ?? "—"}
                {f.mac ? ` / ${f.mac}` : ""}
              </span>
            </li>
          ))}
        </ul>
      )}

      <div className="grid grid-cols-[1fr_1fr_auto] gap-2">
        <input
          className="em-input"
          placeholder="IP address (e.g. 192.168.0.27)"
          value={friendIp}
          onChange={(e) => onFriendIpChange(e.target.value)}
        />
        <input
          className="em-input"
          placeholder="Label (e.g. my pixel)"
          value={friendLabel}
          onChange={(e) => onFriendLabelChange(e.target.value)}
        />
        <button
          className="em-btn-primary"
          disabled={friendBusy || !friendIp.trim()}
          onClick={onAddFriend}
        >
          <Plus className="w-4 h-4" />
          Save
        </button>
      </div>
    </section>
  );
}

function ResultsBlock({
  offers,
  selected,
  pins,
  onToggle,
  onPinChange,
  onVeto,
  onEnroll,
  onRescan,
  scanErr
}: {
  offers: AndroidOffer[];
  selected: Record<string, boolean>;
  pins: Record<string, string>;
  onToggle: (ip: string) => void;
  onPinChange: (ip: string, v: string) => void;
  onVeto: (o: AndroidOffer) => void;
  onEnroll: () => void;
  onRescan: () => void;
  scanErr: string | null;
}) {
  const selCount = Object.values(selected).filter(Boolean).length;
  const needsPin = offers.some(
    (o) => selected[o.ip] && o.pairing_kind === "tls_pair"
  );
  const allPinsEntered = offers
    .filter((o) => selected[o.ip] && o.pairing_kind === "tls_pair")
    .every((o) => (pins[o.ip] ?? "").trim().length >= 6);

  return (
    <section className="em-card p-5 mb-6">
      <div className="flex items-center justify-between mb-3">
        <div>
          <div className="em-eyebrow">Discovered offers</div>
          <div className="text-sm">
            {offers.length} candidate{offers.length === 1 ? "" : "s"} —
            tick which ones to enroll.
          </div>
        </div>
        <button className="em-btn-ghost" onClick={onRescan}>
          <Radar className="w-4 h-4" />
          Rescan
        </button>
      </div>

      {scanErr && (
        <div className="text-xs text-danger-500 mb-3 flex items-center gap-2">
          <AlertTriangle className="w-3 h-3" />
          {scanErr}
        </div>
      )}

      {offers.length === 0 ? (
        <div className="text-center py-10">
          <div className="text-sm text-ink-secondary mb-2">
            Nothing on the wire yet.
          </div>
          <div className="text-xs text-ink-muted leading-relaxed max-w-md mx-auto">
            Make sure wireless debugging is on and the "Pair device with
            pairing code" screen is open on each phone. Some routers
            block multicast — try moving phones to the same SSID as this PC.
          </div>
        </div>
      ) : (
        <ul className="space-y-2">
          {offers.map((o) => {
            const Icon = CLASS_ICON[o.device_class] ?? Smartphone;
            const checked = !!selected[o.ip];
            const isPair = o.pairing_kind === "tls_pair";
            return (
              <li
                key={`${o.ip}:${o.port}`}
                className={`flex items-start gap-3 rounded-lg border p-3 ${
                  checked
                    ? "border-brand-500/50 bg-brand-500/5"
                    : "border-white/5"
                }`}
              >
                <input
                  type="checkbox"
                  className="mt-1 w-4 h-4 accent-brand-500"
                  checked={checked}
                  onChange={() => onToggle(o.ip)}
                />
                <Icon className="w-5 h-5 text-ink-secondary mt-0.5" />
                <div className="flex-1 min-w-0">
                  <div className="font-medium truncate">
                    {o.brand || o.model
                      ? `${o.brand ?? ""} ${o.model ?? ""}`.trim()
                      : o.hostname ?? `Android ${o.ip}`}
                    {o.emulator_suspected && (
                      <span className="em-pill-warn ml-2">emulator?</span>
                    )}
                  </div>
                  <div className="text-xs text-ink-secondary font-mono">
                    {o.ip}:{o.port} ·{" "}
                    <span className="uppercase tracking-wider">
                      {o.pairing_kind.replace("_", " ")}
                    </span>
                    {o.sdk ? ` · sdk ${o.sdk}` : ""}
                    {o.abi ? ` · ${o.abi}` : ""}
                  </div>
                  {checked && isPair && (
                    <input
                      className="em-input mt-2 font-mono w-44"
                      placeholder="6-digit PIN"
                      maxLength={10}
                      inputMode="numeric"
                      value={pins[o.ip] ?? ""}
                      onChange={(e) => onPinChange(o.ip, e.target.value)}
                    />
                  )}
                  {o.hint && (
                    <div className="text-2xs text-ink-muted mt-1">
                      {o.hint}
                    </div>
                  )}
                </div>
                <button
                  className="em-btn-ghost"
                  title="Skip this device permanently"
                  onClick={() => onVeto(o)}
                >
                  <ShieldOff className="w-4 h-4" />
                </button>
              </li>
            );
          })}
        </ul>
      )}

      {offers.length > 0 && (
        <div className="mt-5 flex items-center gap-3">
          <button
            className="em-btn-primary"
            disabled={selCount === 0 || (needsPin && !allPinsEntered)}
            onClick={onEnroll}
          >
            Enroll {selCount} device{selCount === 1 ? "" : "s"}
          </button>
          {needsPin && !allPinsEntered && (
            <span className="text-xs text-ink-secondary">
              Enter the 6-digit PIN shown on each phone first.
            </span>
          )}
        </div>
      )}
    </section>
  );
}

function DoneBlock({
  results,
  onRescan
}: {
  results: EnrollResult[];
  onRescan: () => void;
}) {
  const ok = results.filter((r) => r.ok);
  const failed = results.filter((r) => !r.ok);
  return (
    <section className="em-card p-6 mb-6">
      <div className="flex items-center gap-3 mb-4">
        <CheckCircle2 className="w-6 h-6 text-brand-500" />
        <div>
          <div className="text-lg font-semibold">Enrollment finished</div>
          <div className="text-xs text-ink-secondary">
            {ok.length} succeeded · {failed.length} failed
          </div>
        </div>
      </div>

      {ok.length > 0 && (
        <ul className="space-y-1 text-sm mb-4">
          {ok.map((r) => (
            <li key={`${r.ip}:${r.port}`} className="font-mono">
              <span className="text-brand-500">✓</span>{" "}
              {r.brand ?? "?"} {r.model ?? ""} ({r.ip}) — sdk {r.sdk ?? "?"}
            </li>
          ))}
        </ul>
      )}

      {failed.length > 0 && (
        <ul className="space-y-1 text-xs mb-4 text-danger-500">
          {failed.map((r) => (
            <li key={`${r.ip}:${r.port}-f`} className="font-mono">
              ✗ {r.ip}:{r.port} — {r.error ?? "unknown error"}
            </li>
          ))}
        </ul>
      )}

      <button className="em-btn-ghost" onClick={onRescan}>
        <Radar className="w-4 h-4" />
        Sweep again
      </button>
    </section>
  );
}
