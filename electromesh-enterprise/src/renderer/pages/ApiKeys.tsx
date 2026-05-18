import { useEffect, useState } from "react";
import { Copy, Check, Plus, ShieldAlert, Server } from "lucide-react";
import { bridge } from "../api/bridge";
import { StatusPill } from "../components/StatusPill";
import { EmptyState } from "../components/EmptyState";
import { Modal } from "../components/Modal";
import { formatRelative, shortId } from "../lib/format";

type ApiKeyKind = "access" | "cluster";

interface ApiKeyRow {
  id: string;
  label?: string;
  scopes?: string[];
  created_at?: string;
  last_used_at?: string;
  revoked_at?: string | null;
  key_prefix?: string;
  expires_at?: string | null;
  is_active?: boolean;
  kind?: ApiKeyKind;
  bound_cluster_id?: string | null;
  max_budget_cents?: number | null;
  spent_cents?: number | null;
}

const AVAILABLE_SCOPES = [
  {
    value: "clusters:read",
    label: "clusters:read",
    description: "List clusters and view their (anonymized) composition.",
  },
  {
    value: "clusters:purchase",
    label: "clusters:purchase",
    description: "Purchase a cluster — mints a per-cluster em_cluster_… key.",
  },
  {
    value: "jobs:read",
    label: "jobs:read",
    description: "Read previously-submitted jobs and their progress.",
  },
  {
    value: "clusters:manage_keys",
    label: "clusters:manage_keys",
    description: "Create and revoke other API keys for this enterprise.",
  },
];

function keyState(k: ApiKeyRow): { label: string; tone: "ok" | "danger" | "warn" } {
  if (k.revoked_at) return { label: "revoked", tone: "danger" };
  if (k.expires_at && new Date(k.expires_at) < new Date()) return { label: "expired", tone: "warn" };
  return { label: "active", tone: "ok" };
}

function asRows(raw: unknown): ApiKeyRow[] {
  if (Array.isArray(raw)) return raw as ApiKeyRow[];
  const items = (raw as { items?: ApiKeyRow[] })?.items;
  return Array.isArray(items) ? items : [];
}

function fmtUsd(cents?: number | null): string {
  if (cents == null) return "—";
  return `$${(cents / 100).toFixed(2)}`;
}

export function ApiKeys() {
  const [accessKeys, setAccessKeys] = useState<ApiKeyRow[]>([]);
  const [clusterKeys, setClusterKeys] = useState<ApiKeyRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [creating, setCreating] = useState(false);
  const [newLabel, setNewLabel] = useState("");
  const [newScopes, setNewScopes] = useState<string[]>(["clusters:read", "clusters:purchase"]);
  const [expiresInDays, setExpiresInDays] = useState<number | undefined>(undefined);
  const [createError, setCreateError] = useState<string | null>(null);
  const [submittingCreate, setSubmittingCreate] = useState(false);

  const [issuedKey, setIssuedKey] = useState<{ key: string; label: string; kind: ApiKeyKind } | null>(null);
  const [copied, setCopied] = useState(false);

  const [revokeTarget, setRevokeTarget] = useState<{ id: string; kind: ApiKeyKind } | null>(null);
  const [revokeReason, setRevokeReason] = useState("");
  const [revokeError, setRevokeError] = useState<string | null>(null);
  const [submittingRevoke, setSubmittingRevoke] = useState(false);

  async function refresh() {
    setLoading(true);
    setError(null);
    try {
      const [accessRaw, clusterRaw] = await Promise.all([
        bridge.apiKeys.list("access"),
        bridge.clusterKeys.list(),
      ]);
      setAccessKeys(asRows(accessRaw));
      setClusterKeys(asRows(clusterRaw));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { void refresh(); }, []);

  function resetCreateForm() {
    setNewLabel("");
    setNewScopes(["clusters:read", "clusters:purchase"]);
    setExpiresInDays(undefined);
    setCreateError(null);
  }

  async function createAccessKey() {
    setCreateError(null);
    if (!newLabel.trim()) {
      setCreateError("Label is required.");
      return;
    }
    if (newScopes.length === 0) {
      setCreateError("Pick at least one scope.");
      return;
    }
    setSubmittingCreate(true);
    try {
      const label = newLabel.trim();
      const res = await bridge.apiKeys.create({
        label,
        scopes: newScopes,
        expires_in_days: expiresInDays,
      });
      if (res?.api_key) {
        setIssuedKey({ key: res.api_key, label, kind: "access" });
      }
      setCreating(false);
      resetCreateForm();
      await refresh();
    } catch (err) {
      setCreateError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmittingCreate(false);
    }
  }

  async function revokeKey() {
    if (!revokeTarget) return;
    setRevokeError(null);
    setSubmittingRevoke(true);
    try {
      if (revokeTarget.kind === "access") {
        await bridge.apiKeys.revoke(revokeTarget.id, revokeReason.trim() || undefined);
      } else {
        await bridge.clusterKeys.revoke(revokeTarget.id);
      }
      setRevokeTarget(null);
      setRevokeReason("");
      await refresh();
    } catch (err) {
      setRevokeError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmittingRevoke(false);
    }
  }

  async function copySecret() {
    if (!issuedKey) return;
    try {
      await navigator.clipboard.writeText(issuedKey.key);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard blocked — user can still triple-click */
    }
  }

  const totalCount = accessKeys.length + clusterKeys.length;

  return (
    <main className="page" data-fade>
      <header className="page-header">
        <div>
          <span className="page-header__eyebrow">Account · API keys</span>
          <h1 className="page-header__title">Service credentials</h1>
          <p className="page-header__lede">
            Two key families live here. <strong>Access keys</strong>{" "}
            (<code>em_live_…</code>) authenticate this console and the control
            plane — listing clusters, purchasing them, managing keys.{" "}
            <strong>Cluster keys</strong> (<code>em_cluster_…</code>) are
            minted per-purchase and only let the holder push compute to{" "}
            <em>that one</em> cluster up to its budget. Hand cluster keys to
            CI, hand access keys to nobody.
          </p>
        </div>
        <div className="page-header__actions">
          <button type="button" className="btn btn--primary" onClick={() => setCreating(true)}>
            <Plus size={14} aria-hidden /> New access key
          </button>
        </div>
      </header>

      {error && <div className="auth-error">{error}</div>}

      {loading ? (
        <div className="empty"><span className="spinner" aria-hidden /> Loading keys…</div>
      ) : totalCount === 0 ? (
        <EmptyState
          title="No API keys yet"
          body="Generate an access key to drive jobs from CI or the SDK, or purchase a cluster from the Clusters page to mint a cluster-bound key."
          cta={
            <button type="button" className="btn btn--primary" onClick={() => setCreating(true)}>
              <Plus size={14} aria-hidden /> New access key
            </button>
          }
        />
      ) : (
        <>
          {/* ── access keys ────────────────────────────────────────── */}
          <section className="key-section">
            <header className="key-section__head">
              <div>
                <h2 className="key-section__title">Access keys</h2>
                <p className="mute">
                  Control-plane credentials. Use the <code className="mono">X-API-Key</code>{" "}
                  header (or the SDK's <code className="mono">Client(api_key=…)</code>).
                </p>
              </div>
              <span className="mono mute">{accessKeys.length} key{accessKeys.length === 1 ? "" : "s"}</span>
            </header>
            {accessKeys.length === 0 ? (
              <div className="empty mute">No access keys.</div>
            ) : (
              <table className="t-table">
                <thead>
                  <tr>
                    <th>Label</th>
                    <th>Prefix</th>
                    <th>Scopes</th>
                    <th>Created</th>
                    <th>Last used</th>
                    <th>Expires</th>
                    <th>State</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {accessKeys.map((k) => {
                    const state = keyState(k);
                    return (
                      <tr key={k.id}>
                        <td>
                          <strong>{k.label || "—"}</strong><br />
                          <span className="mono mute">{shortId(k.id)}</span>
                        </td>
                        <td className="mono">{k.key_prefix ? `${k.key_prefix}…` : `${k.id.slice(0, 12)}…`}</td>
                        <td>
                          {(k.scopes || []).map((s) => (
                            <StatusPill key={s} tone="quiet" withDot={false}>{s}</StatusPill>
                          ))}
                        </td>
                        <td className="nowrap">{formatRelative(k.created_at)}</td>
                        <td className="nowrap">{k.last_used_at ? formatRelative(k.last_used_at) : <span className="mute">never</span>}</td>
                        <td className="nowrap">{k.expires_at ? formatRelative(k.expires_at) : <span className="mute">never</span>}</td>
                        <td><StatusPill tone={state.tone}>{state.label}</StatusPill></td>
                        <td>
                          {!k.revoked_at && (
                            <button
                              type="button"
                              className="btn btn--quiet btn--sm"
                              onClick={() => setRevokeTarget({ id: k.id, kind: "access" })}
                            >
                              Revoke
                            </button>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </section>

          {/* ── cluster keys ───────────────────────────────────────── */}
          <section className="key-section">
            <header className="key-section__head">
              <div>
                <h2 className="key-section__title">
                  <Server size={14} aria-hidden style={{ marginRight: 6, verticalAlign: "-2px" }} />
                  Cluster keys
                </h2>
                <p className="mute">
                  Per-purchase, data-plane credentials. Each one is bound to a
                  single cluster and capped by the budget you set at purchase.
                  Send them via the <code className="mono">X-Cluster-Key</code>{" "}
                  header, or just call <code className="mono">compute.run(api_key=…)</code>{" "}
                  from the Conet SDK — it routes by prefix automatically.
                </p>
              </div>
              <span className="mono mute">{clusterKeys.length} key{clusterKeys.length === 1 ? "" : "s"}</span>
            </header>
            {clusterKeys.length === 0 ? (
              <EmptyState
                title="No cluster keys yet"
                body="Open the Clusters page, pick a cluster, hit Purchase. The minted em_cluster_… token appears here."
              />
            ) : (
              <table className="t-table">
                <thead>
                  <tr>
                    <th>Label</th>
                    <th>Prefix</th>
                    <th>Cluster</th>
                    <th>Budget</th>
                    <th>Spent</th>
                    <th>Created</th>
                    <th>Last used</th>
                    <th>State</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {clusterKeys.map((k) => {
                    const state = keyState(k);
                    return (
                      <tr key={k.id}>
                        <td>
                          <strong>{k.label || "—"}</strong><br />
                          <span className="mono mute">{shortId(k.id)}</span>
                        </td>
                        <td className="mono">{k.key_prefix ? `${k.key_prefix}…` : `${k.id.slice(0, 12)}…`}</td>
                        <td className="mono">{k.bound_cluster_id ? shortId(k.bound_cluster_id) : "—"}</td>
                        <td className="nowrap">{fmtUsd(k.max_budget_cents ?? null)}</td>
                        <td className="nowrap">{fmtUsd(k.spent_cents ?? 0)}</td>
                        <td className="nowrap">{formatRelative(k.created_at)}</td>
                        <td className="nowrap">{k.last_used_at ? formatRelative(k.last_used_at) : <span className="mute">never</span>}</td>
                        <td><StatusPill tone={state.tone}>{state.label}</StatusPill></td>
                        <td>
                          {!k.revoked_at && (
                            <button
                              type="button"
                              className="btn btn--quiet btn--sm"
                              onClick={() => setRevokeTarget({ id: k.id, kind: "cluster" })}
                            >
                              Revoke
                            </button>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </section>
        </>
      )}

      {/* ── create access-key dialog ──────────────────────────────────── */}
      <Modal
        open={creating}
        title="Create a new access key"
        body="Access keys authenticate the control plane (list/purchase clusters, manage keys). The plaintext key is shown only once."
        onClose={() => {
          if (submittingCreate) return;
          setCreating(false);
          resetCreateForm();
        }}
        actions={
          <>
            <button
              type="button"
              className="btn btn--quiet"
              onClick={() => { setCreating(false); resetCreateForm(); }}
              disabled={submittingCreate}
            >
              Cancel
            </button>
            <button
              type="button"
              className="btn btn--primary"
              onClick={() => void createAccessKey()}
              disabled={submittingCreate || !newLabel.trim() || newScopes.length === 0}
            >
              {submittingCreate ? "Creating…" : "Create key"}
            </button>
          </>
        }
      >
        {createError && <div className="dialog-error">{createError}</div>}

        <div className="field">
          <label htmlFor="kl">Label</label>
          <input
            id="kl"
            value={newLabel}
            onChange={(e) => setNewLabel(e.target.value)}
            placeholder="ci-pipeline · production · staging-bot"
            autoFocus
            maxLength={120}
          />
        </div>

        <div className="field">
          <label>Scopes</label>
          <div className="scope-grid">
            {AVAILABLE_SCOPES.map((scope) => {
              const active = newScopes.includes(scope.value);
              return (
                <label
                  key={scope.value}
                  className={`scope-grid__row${active ? " is-active" : ""}`}
                >
                  <input
                    type="checkbox"
                    className="scope-grid__check"
                    checked={active}
                    onChange={(e) => {
                      setNewScopes(
                        e.target.checked
                          ? [...newScopes, scope.value]
                          : newScopes.filter((s) => s !== scope.value)
                      );
                    }}
                  />
                  <div>
                    <div className="scope-grid__name">{scope.label}</div>
                    <div className="scope-grid__help">{scope.description}</div>
                  </div>
                </label>
              );
            })}
          </div>
        </div>

        <div className="field">
          <label htmlFor="expire">Expiration</label>
          <select
            id="expire"
            value={expiresInDays?.toString() || ""}
            onChange={(e) => setExpiresInDays(e.target.value ? parseInt(e.target.value) : undefined)}
          >
            <option value="">Never expires</option>
            <option value="7">7 days</option>
            <option value="30">30 days</option>
            <option value="90">90 days</option>
            <option value="365">1 year</option>
          </select>
        </div>
      </Modal>

      {/* ── secret reveal ──────────────────────────────────────────── */}
      <Modal
        open={Boolean(issuedKey)}
        title={`Key issued: ${issuedKey?.label ?? ""}`}
        body={
          issuedKey?.kind === "cluster"
            ? "Cluster key minted. It will only work against the cluster it was purchased for. Copy now — we won't show it again."
            : "Access key minted. This is the only time the full secret will be shown. Copy it now."
        }
        onClose={() => { setIssuedKey(null); setCopied(false); }}
        actions={
          <button type="button" className="btn btn--primary" onClick={() => { setIssuedKey(null); setCopied(false); }}>
            I've saved it
          </button>
        }
      >
        <div className="apikey-secret">
          <code>{issuedKey?.key}</code>
          <button
            type="button"
            className={`btn btn--sm ${copied ? "btn--ghost" : "btn--soft"}`}
            onClick={() => void copySecret()}
            title="Copy to clipboard"
          >
            {copied ? <><Check size={12} aria-hidden /> Copied</> : <><Copy size={12} aria-hidden /> Copy</>}
          </button>
        </div>
        <div className="apikey-secret__warn">
          <ShieldAlert size={14} aria-hidden style={{ flexShrink: 0, marginTop: 1 }} />
          <span>
            Treat this like a password. Anyone with this string can spend
            against your enterprise account up to its budget. Store it in a
            secrets manager, never in source control.
          </span>
        </div>
      </Modal>

      {/* ── revoke confirmation ────────────────────────────────────── */}
      <Modal
        open={Boolean(revokeTarget)}
        title={revokeTarget?.kind === "cluster" ? "Revoke this cluster key?" : "Revoke this access key?"}
        body="Revoked keys stop authenticating immediately and can never be reactivated."
        onClose={() => {
          if (submittingRevoke) return;
          setRevokeTarget(null);
          setRevokeReason("");
          setRevokeError(null);
        }}
        actions={
          <>
            <button
              type="button"
              className="btn btn--quiet"
              onClick={() => { setRevokeTarget(null); setRevokeReason(""); setRevokeError(null); }}
              disabled={submittingRevoke}
            >
              Cancel
            </button>
            <button
              type="button"
              className="btn btn--danger"
              onClick={() => void revokeKey()}
              disabled={submittingRevoke}
            >
              {submittingRevoke ? "Revoking…" : "Revoke key"}
            </button>
          </>
        }
      >
        {revokeError && <div className="dialog-error">{revokeError}</div>}

        {revokeTarget?.kind === "access" && (
          <div className="field">
            <label htmlFor="reason">Reason for audit log (optional)</label>
            <input
              id="reason"
              type="text"
              value={revokeReason}
              onChange={(e) => setRevokeReason(e.target.value)}
              placeholder="e.g. leaked in screenshot, rotated quarterly, dev finished"
              maxLength={512}
            />
          </div>
        )}
      </Modal>
    </main>
  );
}
