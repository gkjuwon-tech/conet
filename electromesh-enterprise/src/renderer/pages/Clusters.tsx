import { useEffect, useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { Server, RefreshCw, ArrowRight, ShoppingCart, Copy, Check, ShieldAlert } from "lucide-react";
import { bridge } from "../api/bridge";
import { StatusPill } from "../components/StatusPill";
import { EmptyState } from "../components/EmptyState";
import { Modal } from "../components/Modal";
import { formatRelative } from "../lib/format";

interface ClusterCard {
  id: string;
  handle: string;
  sequence_no: number;
  status: "forming" | "available" | "leased" | "draining" | "retired";
  member_count: number;
  target_size: number;
  h100_equivalent: number;
  reliability_score: number;
  trust_score: number;
  price_usd_per_hour: number;
  region_hint?: string | null;
  available_at?: string | null;
}

interface ClusterMemberCard {
  device_class: string;
  h100_equivalent: number;
  weight: number;
  reliability_score: number;
  trust_score: number;
}

interface ClusterDetail extends ClusterCard {
  aggregate_cpu_gflops: number;
  aggregate_gpu_gflops: number;
  aggregate_ram_mb: number;
  aggregate_vram_mb: number;
  aggregate_hash_mhs_sha256: number;
  aggregate_network_mbps: number;
  diversity_index: number;
  price_breakdown?: Record<string, number> | null;
  members?: ClusterMemberCard[];
}

interface IssuedClusterKey {
  api_key: string;
  label?: string;
  bound_cluster_id?: string;
  max_budget_cents?: number;
}

const STATUS_TONE: Record<string, "ok" | "warn" | "quiet" | "danger"> = {
  forming: "warn",
  available: "ok",
  leased: "quiet",
  draining: "warn",
  retired: "danger",
};

function pct(x: number): string {
  return `${(x * 100).toFixed(0)}%`;
}

function shortNum(n: number, unit: string): string {
  if (n > 1_000_000) return `${(n / 1_000_000).toFixed(1)}M ${unit}`;
  if (n > 1_000) return `${(n / 1_000).toFixed(1)}k ${unit}`;
  return `${n.toFixed(0)} ${unit}`;
}

function CompositionBar({ members }: { members: ClusterMemberCard[] }) {
  const byClass = useMemo(() => {
    const m: Record<string, number> = {};
    for (const member of members) {
      m[member.device_class] = (m[member.device_class] ?? 0) + member.weight;
    }
    const total = Object.values(m).reduce((s, v) => s + v, 0) || 1;
    return Object.entries(m)
      .map(([cls, w]) => ({ cls, share: w / total }))
      .sort((a, b) => b.share - a.share);
  }, [members]);

  return (
    <div className="composition">
      <div className="composition__bar">
        {byClass.map((c, i) => (
          <span
            key={c.cls}
            className="composition__seg"
            style={{
              width: `${c.share * 100}%`,
              background: `hsl(${(i * 53) % 360} 60% 55% / 0.7)`,
            }}
            title={`${c.cls} · ${pct(c.share)}`}
          />
        ))}
      </div>
      <div className="composition__legend">
        {byClass.map((c) => (
          <span key={c.cls} className="composition__chip">
            <span className="composition__dot" /> {c.cls} <strong>{pct(c.share)}</strong>
          </span>
        ))}
      </div>
    </div>
  );
}

export function Clusters() {
  const nav = useNavigate();
  const { id: selectedId } = useParams();

  const [list, setList] = useState<ClusterCard[]>([]);
  const [detail, setDetail] = useState<ClusterDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [detailLoading, setDetailLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<string>("all");

  // ── purchase flow state ────────────────────────────────────────────
  const [purchaseOpen, setPurchaseOpen] = useState(false);
  const [purchaseLabel, setPurchaseLabel] = useState("");
  const [purchaseBudgetUsd, setPurchaseBudgetUsd] = useState<string>("100");
  const [purchaseExpiresDays, setPurchaseExpiresDays] = useState<number | undefined>(undefined);
  const [purchaseError, setPurchaseError] = useState<string | null>(null);
  const [purchasing, setPurchasing] = useState(false);

  const [issued, setIssued] = useState<IssuedClusterKey | null>(null);
  const [copied, setCopied] = useState(false);

  async function refresh() {
    setLoading(true);
    setError(null);
    try {
      const raw = await bridge.clusters.list();
      const items = Array.isArray(raw) ? (raw as ClusterCard[]) : ((raw as { items?: ClusterCard[] })?.items ?? []);
      setList(items);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { void refresh(); }, []);

  useEffect(() => {
    if (!selectedId) {
      setDetail(null);
      return;
    }
    let cancelled = false;
    setDetailLoading(true);
    bridge.clusters.get(selectedId)
      .then((raw) => { if (!cancelled) setDetail(raw as ClusterDetail); })
      .catch((err) => { if (!cancelled) setError(err instanceof Error ? err.message : String(err)); })
      .finally(() => { if (!cancelled) setDetailLoading(false); });
    return () => { cancelled = true; };
  }, [selectedId]);

  const filtered = useMemo(() => {
    if (statusFilter === "all") return list;
    return list.filter((c) => c.status === statusFilter);
  }, [list, statusFilter]);

  function openPurchase() {
    if (!detail) return;
    setPurchaseLabel(`${detail.handle}-key`);
    setPurchaseBudgetUsd("100");
    setPurchaseExpiresDays(undefined);
    setPurchaseError(null);
    setPurchaseOpen(true);
  }

  async function submitPurchase() {
    if (!detail) return;
    setPurchaseError(null);
    const label = purchaseLabel.trim();
    if (!label) {
      setPurchaseError("Label is required.");
      return;
    }
    const usd = Number.parseFloat(purchaseBudgetUsd);
    if (!Number.isFinite(usd) || usd <= 0) {
      setPurchaseError("Budget must be a positive USD amount.");
      return;
    }
    const budget_cents = Math.round(usd * 100);
    setPurchasing(true);
    try {
      const res = await bridge.clusterKeys.purchase(detail.id, {
        label,
        budget_cents,
        expires_in_days: purchaseExpiresDays,
      });
      if (res?.api_key) {
        setIssued({
          api_key: res.api_key,
          label: res.label ?? label,
          bound_cluster_id: res.bound_cluster_id ?? detail.id,
          max_budget_cents: res.max_budget_cents ?? budget_cents,
        });
      }
      setPurchaseOpen(false);
    } catch (err) {
      setPurchaseError(err instanceof Error ? err.message : String(err));
    } finally {
      setPurchasing(false);
    }
  }

  async function copyIssued() {
    if (!issued) return;
    try {
      await navigator.clipboard.writeText(issued.api_key);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard blocked */
    }
  }

  return (
    <main className="page" data-fade>
      <header className="page-header">
        <div>
          <span className="page-header__eyebrow">Compute · Clusters</span>
          <h1 className="page-header__title">Available cluster pool</h1>
          <p className="page-header__lede">
            Anonymized snapshots of the live mesh. We don't show you which
            individual devices you're renting — you rent the aggregate. Each
            cluster's H100-equivalent score is what your job spec targets.
            Purchase one to mint a per-cluster <code>em_cluster_…</code> key
            you can plug into the Conet SDK.
          </p>
        </div>
        <div className="page-header__actions">
          <button
            type="button"
            className="btn btn--ghost"
            onClick={() => void refresh()}
            disabled={loading}
          >
            <RefreshCw size={14} aria-hidden /> {loading ? "Refreshing…" : "Refresh"}
          </button>
        </div>
      </header>

      {error && <div className="auth-error">{error}</div>}

      <div className="devices-toolbar">
        <div className="cluster">
          <span className="mono mute" style={{ fontSize: 11, letterSpacing: "0.12em" }}>STATUS</span>
        </div>
        <div className="segmented">
          {["all", "available", "forming", "leased"].map((s) => (
            <button
              key={s}
              type="button"
              className={statusFilter === s ? "is-active" : ""}
              onClick={() => setStatusFilter(s)}
            >
              {s}
            </button>
          ))}
        </div>
        <div className="grow" />
        <span className="mono mute">{filtered.length} cluster{filtered.length === 1 ? "" : "s"}</span>
      </div>

      <div className="clusters-layout">
        <section className="clusters-layout__list">
          {loading ? (
            <div className="empty"><span className="spinner" aria-hidden /> Loading clusters…</div>
          ) : filtered.length === 0 ? (
            <EmptyState
              title="No clusters match"
              body="Loosen the filter, or check back in a few minutes — clusters form continuously as devices come online."
            />
          ) : (
            <ul className="cluster-list">
              {filtered.map((c) => {
                const active = c.id === selectedId;
                return (
                  <li
                    key={c.id}
                    className={`cluster-list__row${active ? " is-active" : ""}`}
                    onClick={() => nav(`/clusters/${c.id}`)}
                  >
                    <div className="cluster-list__head">
                      <Server size={14} aria-hidden />
                      <strong className="mono">{c.handle}</strong>
                      <StatusPill tone={STATUS_TONE[c.status] ?? "quiet"}>{c.status}</StatusPill>
                    </div>
                    <div className="cluster-list__stats">
                      <span><dt>H100eq</dt><dd>{c.h100_equivalent.toFixed(2)}</dd></span>
                      <span><dt>Members</dt><dd>{c.member_count}/{c.target_size}</dd></span>
                      <span><dt>Reliability</dt><dd>{pct(c.reliability_score)}</dd></span>
                      <span><dt>$/hr</dt><dd>${c.price_usd_per_hour.toFixed(2)}</dd></span>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </section>

        <aside className="clusters-layout__detail">
          {selectedId && detailLoading && (
            <div className="empty"><span className="spinner" aria-hidden /> Loading detail…</div>
          )}
          {selectedId && !detailLoading && detail && (
            <article className="cluster-detail">
              <header className="cluster-detail__head">
                <span className="page-header__eyebrow">Cluster</span>
                <h2 className="mono">{detail.handle}</h2>
                <p className="mute">
                  Sequence #{detail.sequence_no} · {detail.region_hint || "global"} ·
                  available {detail.available_at ? formatRelative(detail.available_at) : "—"}
                </p>
              </header>

              <section className="cluster-detail__grid">
                <div className="bignum">
                  <span className="bignum__label">H100 equivalent</span>
                  <span className="bignum__value">{detail.h100_equivalent.toFixed(2)}</span>
                </div>
                <div className="bignum">
                  <span className="bignum__label">Price per hour</span>
                  <span className="bignum__value">${detail.price_usd_per_hour.toFixed(2)}</span>
                </div>
                <div className="bignum">
                  <span className="bignum__label">Reliability</span>
                  <span className="bignum__value">{pct(detail.reliability_score)}</span>
                </div>
                <div className="bignum">
                  <span className="bignum__label">Trust</span>
                  <span className="bignum__value">{pct(detail.trust_score)}</span>
                </div>
                <div className="bignum">
                  <span className="bignum__label">Diversity</span>
                  <span className="bignum__value">{pct(detail.diversity_index)}</span>
                </div>
                <div className="bignum">
                  <span className="bignum__label">Members</span>
                  <span className="bignum__value">{detail.member_count}/{detail.target_size}</span>
                </div>
              </section>

              <section className="cluster-detail__capacity">
                <h3>Aggregate capacity</h3>
                <dl>
                  <div><dt>CPU</dt><dd>{shortNum(detail.aggregate_cpu_gflops, "GFLOPS")}</dd></div>
                  <div><dt>GPU</dt><dd>{shortNum(detail.aggregate_gpu_gflops, "GFLOPS")}</dd></div>
                  <div><dt>RAM</dt><dd>{shortNum(detail.aggregate_ram_mb, "MB")}</dd></div>
                  <div><dt>VRAM</dt><dd>{shortNum(detail.aggregate_vram_mb, "MB")}</dd></div>
                  <div><dt>SHA256</dt><dd>{shortNum(detail.aggregate_hash_mhs_sha256, "MH/s")}</dd></div>
                  <div><dt>Network</dt><dd>{shortNum(detail.aggregate_network_mbps, "Mbps")}</dd></div>
                </dl>
              </section>

              {detail.members && detail.members.length > 0 && (
                <section className="cluster-detail__composition">
                  <h3>Composition <span className="mute">· no device IDs are shown</span></h3>
                  <CompositionBar members={detail.members} />
                </section>
              )}

              <footer className="cluster-detail__actions">
                <button
                  type="button"
                  className="btn btn--primary"
                  onClick={openPurchase}
                  disabled={detail.status !== "available"}
                  title={detail.status !== "available" ? `Cluster is ${detail.status}` : undefined}
                >
                  <ShoppingCart size={14} aria-hidden /> Purchase &amp; mint cluster key
                </button>
                <button
                  type="button"
                  className="btn btn--ghost"
                  onClick={() => nav(`/jobs/new?target_h100=${detail.h100_equivalent.toFixed(2)}`)}
                >
                  Submit a job here <ArrowRight size={14} aria-hidden />
                </button>
              </footer>
            </article>
          )}
          {!selectedId && !loading && (
            <div className="cluster-detail__placeholder">
              <Server size={28} aria-hidden />
              <p>Select a cluster on the left to see its anonymized composition.</p>
            </div>
          )}
        </aside>
      </div>

      {/* ── purchase dialog ─────────────────────────────────────────── */}
      <Modal
        open={purchaseOpen}
        title={detail ? `Purchase ${detail.handle}` : "Purchase cluster"}
        body="Mints a new em_cluster_… key bound to this cluster. The key can only push compute to this cluster and only up to the budget you set here."
        onClose={() => {
          if (purchasing) return;
          setPurchaseOpen(false);
        }}
        actions={
          <>
            <button
              type="button"
              className="btn btn--quiet"
              onClick={() => setPurchaseOpen(false)}
              disabled={purchasing}
            >
              Cancel
            </button>
            <button
              type="button"
              className="btn btn--primary"
              onClick={() => void submitPurchase()}
              disabled={purchasing || !purchaseLabel.trim() || !purchaseBudgetUsd.trim()}
            >
              {purchasing ? "Purchasing…" : "Purchase"}
            </button>
          </>
        }
      >
        {purchaseError && <div className="dialog-error">{purchaseError}</div>}

        <div className="field">
          <label htmlFor="pkey-label">Label</label>
          <input
            id="pkey-label"
            value={purchaseLabel}
            onChange={(e) => setPurchaseLabel(e.target.value)}
            placeholder="render-pipeline · staging-train · etc"
            maxLength={120}
            autoFocus
          />
          <span className="field-hint">
            Free-form label that shows up next to the minted key on the API
            Keys page.
          </span>
        </div>

        <div className="field">
          <label htmlFor="pkey-budget">Budget (USD)</label>
          <input
            id="pkey-budget"
            type="number"
            min={1}
            step="0.01"
            value={purchaseBudgetUsd}
            onChange={(e) => setPurchaseBudgetUsd(e.target.value)}
            placeholder="100.00"
          />
          <span className="field-hint">
            Hard cap on cumulative spend through this key. Stored in cents on
            the backend.
          </span>
        </div>

        <div className="field">
          <label htmlFor="pkey-expires">Expiration</label>
          <select
            id="pkey-expires"
            value={purchaseExpiresDays?.toString() || ""}
            onChange={(e) => setPurchaseExpiresDays(e.target.value ? parseInt(e.target.value) : undefined)}
          >
            <option value="">Never expires</option>
            <option value="7">7 days</option>
            <option value="30">30 days</option>
            <option value="90">90 days</option>
            <option value="365">1 year</option>
          </select>
        </div>
      </Modal>

      {/* ── secret reveal ───────────────────────────────────────────── */}
      <Modal
        open={Boolean(issued)}
        title={`Cluster key issued: ${issued?.label ?? ""}`}
        body="This is the only time the full secret will be shown. Copy it before closing — anything pushing compute against this cluster will use this string."
        onClose={() => { setIssued(null); setCopied(false); }}
        actions={
          <button
            type="button"
            className="btn btn--primary"
            onClick={() => { setIssued(null); setCopied(false); }}
          >
            I've saved it
          </button>
        }
      >
        <div className="apikey-secret">
          <code>{issued?.api_key}</code>
          <button
            type="button"
            className={`btn btn--sm ${copied ? "btn--ghost" : "btn--soft"}`}
            onClick={() => void copyIssued()}
            title="Copy to clipboard"
          >
            {copied ? <><Check size={12} aria-hidden /> Copied</> : <><Copy size={12} aria-hidden /> Copy</>}
          </button>
        </div>

        <div className="apikey-secret__warn">
          <ShieldAlert size={14} aria-hidden style={{ flexShrink: 0, marginTop: 1 }} />
          <span>
            Bound to cluster <code className="mono">{issued?.bound_cluster_id ?? "—"}</code>.
            Budget: <strong>${((issued?.max_budget_cents ?? 0) / 100).toFixed(2)}</strong>.
            Plug it into <code className="mono">compute.run(api_key="em_cluster_…", payload=…)</code>.
          </span>
        </div>
      </Modal>
    </main>
  );
}
