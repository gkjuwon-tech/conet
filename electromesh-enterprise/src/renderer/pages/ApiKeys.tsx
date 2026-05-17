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
}

export function ApiKeys() {
  const [keys, setKeys] = useState<ApiKeyRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [newLabel, setNewLabel] = useState("");
  const [newScopes, setNewScopes] = useState("read,write");
  const [issuedKey, setIssuedKey] = useState<string | null>(null);

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
        scopes: newScopes.split(",").map((s) => s.trim()).filter(Boolean)
      });
      if (res.api_key) setIssuedKey(res.api_key);
      setCreating(false);
      setNewLabel("");
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function revoke(id: string) {
    setError(null);
    try {
      await bridge.apiKeys.revoke(id);
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
                    <button type="button" className="btn btn--quiet btn--sm" onClick={() => void revoke(k.id)}>
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
        title="Issue a new API key"
        body="The key will be shown once. Copy it into your secret store before closing the dialog."
        onClose={() => setCreating(false)}
        actions={
          <>
            <button type="button" className="btn btn--quiet" onClick={() => setCreating(false)}>Cancel</button>
            <button type="button" className="btn btn--primary" onClick={() => void createKey()}>Issue key</button>
          </>
        }
      >
        <div className="field">
          <label htmlFor="kl">Label</label>
          <input id="kl" value={newLabel} onChange={(e) => setNewLabel(e.target.value)} placeholder="ci-pipeline" />
        </div>
        <div className="field">
          <label htmlFor="ks">Scopes (comma-separated)</label>
          <input id="ks" value={newScopes} onChange={(e) => setNewScopes(e.target.value)} placeholder="read,write" />
        </div>
      </Modal>

      <Modal
        open={Boolean(issuedKey)}
        title="Your new API key"
        body="This is the only time you'll see this secret. Copy it now."
        onClose={() => setIssuedKey(null)}
        actions={
          <button type="button" className="btn btn--primary" onClick={() => setIssuedKey(null)}>I've saved it</button>
        }
      >
        <div className="key-display">
          <KeyRound size={16} aria-hidden />
          <code>{issuedKey}</code>
          <button
            type="button"
            className="btn btn--quiet btn--sm"
            onClick={() => { if (issuedKey) void navigator.clipboard.writeText(issuedKey); }}
          >
            <Copy size={12} aria-hidden /> Copy
          </button>
        </div>
      </Modal>
    </main>
  );
}
