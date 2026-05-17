import { useEffect, useState } from "react";
import { Copy, Check, Plus, ShieldAlert } from "lucide-react";
import { bridge } from "../api/bridge";
import { StatusPill } from "../components/StatusPill";
import { EmptyState } from "../components/EmptyState";
import { Modal } from "../components/Modal";
import { formatRelative, shortId } from "../lib/format";

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
}

const AVAILABLE_SCOPES = [
  {
    value: "clusters:read",
    label: "clusters:read",
    description: "List clusters and view their (anonymized) composition.",
  },
  {
    value: "clusters:submit_job",
    label: "clusters:submit_job",
    description: "Submit compute jobs against the cluster pool. Bills the enterprise.",
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

export function ApiKeys() {
  const [keys, setKeys] = useState<ApiKeyRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [creating, setCreating] = useState(false);
  const [newLabel, setNewLabel] = useState("");
  const [newScopes, setNewScopes] = useState<string[]>(["clusters:read", "clusters:submit_job"]);
  const [expiresInDays, setExpiresInDays] = useState<number | undefined>(undefined);
  const [createError, setCreateError] = useState<string | null>(null);
  const [submittingCreate, setSubmittingCreate] = useState(false);

  const [issuedKey, setIssuedKey] = useState<{ key: string; label: string } | null>(null);
  const [copied, setCopied] = useState(false);

  const [revokeId, setRevokeId] = useState<string | null>(null);
  const [revokeReason, setRevokeReason] = useState("");
  const [revokeError, setRevokeError] = useState<string | null>(null);
  const [submittingRevoke, setSubmittingRevoke] = useState(false);

  async function refresh() {
    setLoading(true);
    setError(null);
    try {
      const raw = await bridge.apiKeys.list();
      const items = Array.isArray(raw) ? raw as ApiKeyRow[] : (raw as { items?: ApiKeyRow[] })?.items || [];
      setKeys(items);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { void refresh(); }, []);

  function resetCreateForm() {
    setNewLabel("");
    setNewScopes(["clusters:read", "clusters:submit_job"]);
    setExpiresInDays(undefined);
    setCreateError(null);
  }

  async function createKey() {
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
        setIssuedKey({ key: res.api_key, label });
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
    if (!revokeId) return;
    setRevokeError(null);
    setSubmittingRevoke(true);
    try {
      await bridge.apiKeys.revoke(revokeId, revokeReason.trim() || undefined);
      setRevokeId(null);
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

  return (
    <main className="page" data-fade>
      <header className="page-header">
        <div>
          <span className="page-header__eyebrow">Account · API keys</span>
          <h1 className="page-header__title">Service credentials</h1>
          <p className="page-header__lede">
            Bearer tokens for headless integrations and the Conet SDKs. Each key
            carries its own scopes and last-used timestamp — issue narrow ones,
            rotate them aggressively, revoke on the slightest suspicion.
          </p>
        </div>
        <div className="page-header__actions">
          <button type="button" className="btn btn--primary" onClick={() => setCreating(true)}>
            <Plus size={14} aria-hidden /> New API key
          </button>
        </div>
      </header>

      {error && <div className="auth-error">{error}</div>}

      {loading ? (
        <div className="empty"><span className="spinner" aria-hidden /> Loading keys…</div>
      ) : keys.length === 0 ? (
        <EmptyState
          title="No API keys yet"
          body="Generate a key to drive jobs from CI or the SDK without using the operator console."
          cta={
            <button type="button" className="btn btn--primary" onClick={() => setCreating(true)}>
              <Plus size={14} aria-hidden /> New API key
            </button>
          }
        />
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
            {keys.map((k) => {
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
                      <button type="button" className="btn btn--quiet btn--sm" onClick={() => setRevokeId(k.id)}>
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

      {/* ── create dialog ──────────────────────────────────────────── */}
      <Modal
        open={creating}
        title="Create a new API key"
        body="The plaintext key is shown only once. Copy it into your secrets store before closing the dialog."
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
              onClick={() => void createKey()}
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
        body="This is the only time the full secret will be shown. Copy it now."
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
            Treat this like a password. Anyone with this string can spend against
            your enterprise account, up to your spend cap. Store it in a secrets
            manager, never in source control.
          </span>
        </div>
      </Modal>

      {/* ── revoke confirmation ────────────────────────────────────── */}
      <Modal
        open={Boolean(revokeId)}
        title="Revoke this key?"
        body="Revoked keys stop authenticating immediately and can never be reactivated."
        onClose={() => {
          if (submittingRevoke) return;
          setRevokeId(null);
          setRevokeReason("");
          setRevokeError(null);
        }}
        actions={
          <>
            <button
              type="button"
              className="btn btn--quiet"
              onClick={() => { setRevokeId(null); setRevokeReason(""); setRevokeError(null); }}
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
      </Modal>
    </main>
  );
}
