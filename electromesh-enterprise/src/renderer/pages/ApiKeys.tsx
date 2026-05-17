import { useEffect, useState } from "react";
import { Copy, KeyRound, Plus } from "lucide-react";
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
  { value: "clusters:read", label: "Read clusters", description: "List and view cluster details" },
  { value: "clusters:submit_job", label: "Submit jobs", description: "Submit compute jobs to clusters" },
  { value: "clusters:manage_keys", label: "Manage keys", description: "Create and revoke API keys" },
  { value: "jobs:read", label: "Read jobs", description: "List and view job details" },
];

export function ApiKeys() {
  const [keys, setKeys] = useState<ApiKeyRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [newLabel, setNewLabel] = useState("");
  const [newScopes, setNewScopes] = useState<string[]>(["clusters:read", "clusters:submit_job"]);
  const [expiresInDays, setExpiresInDays] = useState<number | undefined>(undefined);
  const [issuedKey, setIssuedKey] = useState<{ key: string; label: string } | null>(null);
  const [revokeId, setRevokeId] = useState<string | null>(null);
  const [revokeReason, setRevokeReason] = useState("");

  async function refresh() {
    setLoading(true);
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

  async function createKey() {
    setError(null);
    try {
      const res = await bridge.apiKeys.create({
        label: newLabel.trim() || `key-${Date.now()}`,
        scopes: newScopes,
        expires_in_days: expiresInDays
      });
      if (res.api_key) {
        setIssuedKey({ key: res.api_key, label: newLabel.trim() || `key-${Date.now()}` });
      }
      setCreating(false);
      setNewLabel("");
      setNewScopes(["clusters:read", "clusters:submit_job"]);
      setExpiresInDays(undefined);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function revokeKey() {
    if (!revokeId) return;
    setError(null);
    try {
      await bridge.apiKeys.revoke(revokeId);
      setRevokeId(null);
      setRevokeReason("");
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  return (
    <main className="page" data-fade>
      <header className="page-header">
        <div>
          <span className="page-header__eyebrow">Account · API keys</span>
          <h1 className="page-header__title">Service credentials</h1>
          <p className="page-header__lede">
            API keys for headless integrations and CI. Every key carries scopes
            and is auditable independently. Revoke keys aggressively when in
            doubt — they're cheap to mint.
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
              <th>State</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {keys.map((k) => (
              <tr key={k.id}>
                <td><strong>{k.label || "—"}</strong><br /><span className="mono mute">{shortId(k.id)}</span></td>
                <td className="mono">{k.key_prefix || k.id.slice(0, 12)}…</td>
                <td>{(k.scopes || []).map((s) => <StatusPill key={s} tone="quiet" withDot={false}>{s}</StatusPill>)}</td>
                <td className="nowrap">{formatRelative(k.created_at)}</td>
                <td className="nowrap">{formatRelative(k.last_used_at)}</td>
                <td>
                  {k.revoked_at
                    ? <StatusPill tone="danger">revoked</StatusPill>
                    : <StatusPill tone="ok">active</StatusPill>}
                </td>
                <td>
                  {!k.revoked_at && (
                    <button type="button" className="btn btn--quiet btn--sm" onClick={() => setRevokeId(k.id)}>
                      Revoke
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <Modal
        open={creating}
        title="Create a new API key"
        body="The key will be shown only once. Copy it into your secret store."
        onClose={() => {
          setCreating(false);
          setError(null);
        }}
        actions={
          <>
            <button type="button" className="btn btn--quiet" onClick={() => {
              setCreating(false);
              setError(null);
            }}>Cancel</button>
            <button type="button" className="btn btn--primary" onClick={() => void createKey()} disabled={!newLabel.trim()}>
              Create key
            </button>
          </>
        }
      >
        {error && <div style={{ color: "var(--fg-error)", marginBottom: 16, fontSize: 14 }}>{error}</div>}

        <div className="field">
          <label htmlFor="kl">Label</label>
          <input
            id="kl"
            value={newLabel}
            onChange={(e) => setNewLabel(e.target.value)}
            placeholder="e.g., CI/CD Pipeline, Production"
            autoFocus
          />
        </div>

        <div className="field">
          <label>Scopes (select at least one)</label>
          <div style={{ display: "grid", gap: 12 }}>
            {AVAILABLE_SCOPES.map((scope) => (
              <label key={scope.value} style={{ display: "flex", gap: 8, alignItems: "flex-start", cursor: "pointer" }}>
                <input
                  type="checkbox"
                  checked={newScopes.includes(scope.value)}
                  onChange={(e) => {
                    if (e.target.checked) {
                      setNewScopes([...newScopes, scope.value]);
                    } else {
                      setNewScopes(newScopes.filter((s) => s !== scope.value));
                    }
                  }}
                />
                <div>
                  <div style={{ fontWeight: 600 }}>{scope.label}</div>
                  <div style={{ fontSize: 12, color: "var(--fg-mute)" }}>{scope.description}</div>
                </div>
              </label>
            ))}
          </div>
        </div>

        <div className="field">
          <label htmlFor="expire">Expiration (optional)</label>
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

      <Modal
        open={Boolean(issuedKey)}
        title="Your new API key"
        body={`"${issuedKey?.label}" — This is the only time you'll see this secret.`}
        onClose={() => setIssuedKey(null)}
        actions={
          <button type="button" className="btn btn--primary" onClick={() => setIssuedKey(null)}>
            I've saved it securely
          </button>
        }
      >
        <div style={{
          padding: 16,
          background: "var(--bg-alt)",
          borderRadius: 8,
          fontFamily: "monospace",
          fontSize: 12,
          wordBreak: "break-all",
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          gap: 12
        }}>
          <code>{issuedKey?.key}</code>
          <button
            type="button"
            className="btn btn--ghost btn--sm"
            onClick={() => { if (issuedKey) void navigator.clipboard.writeText(issuedKey.key); }}
            title="Copy to clipboard"
          >
            <Copy size={14} aria-hidden />
          </button>
        </div>
      </Modal>

      <Modal
        open={Boolean(revokeId)}
        title="Revoke API key?"
        body="Revoked keys can never be used again. This action cannot be undone."
        onClose={() => {
          setRevokeId(null);
          setRevokeReason("");
          setError(null);
        }}
        actions={
          <>
            <button type="button" className="btn btn--quiet" onClick={() => {
              setRevokeId(null);
              setRevokeReason("");
              setError(null);
            }}>Cancel</button>
            <button type="button" className="btn btn--danger" onClick={() => void revokeKey()}>
              Revoke key
            </button>
          </>
        }
      >
        {error && <div style={{ color: "var(--fg-error)", marginBottom: 16, fontSize: 14 }}>{error}</div>}

        <div className="field">
          <label htmlFor="reason">Reason (optional)</label>
          <input
            id="reason"
            type="text"
            value={revokeReason}
            onChange={(e) => setRevokeReason(e.target.value)}
            placeholder="e.g., Leaked, Rotated, No longer needed"
          />
        </div>
      </Modal>
    </main>
  );
}
