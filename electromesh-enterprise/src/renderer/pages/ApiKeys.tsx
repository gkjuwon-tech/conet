import { useEffect, useState } from "react";
import { Copy, Plus, Trash2 } from "lucide-react";
import { PageHeader } from "../components/PageHeader";
import { bridge, type ApiKeyCreated, type ApiKeyPublic } from "../api/bridge";
import { fmtRelative } from "../lib/format";

const SCOPES = [
  "jobs.submit",
  "jobs.read",
  "jobs.cancel",
  "marketplace.read",
  "billing.read",
  "billing.write"
];

export function ApiKeys() {
  const [items, setItems] = useState<ApiKeyPublic[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [createdSecret, setCreatedSecret] = useState<ApiKeyCreated | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [label, setLabel] = useState("");
  const [scopes, setScopes] = useState<string[]>(["jobs.submit", "jobs.read"]);
  const [expiresIn, setExpiresIn] = useState<number | "">(365);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void load();
  }, []);

  async function load() {
    const res = await bridge.apiKeys.list();
    if (res.ok) setItems(res.data as ApiKeyPublic[]);
    else setError(res.error ?? null);
  }

  async function create() {
    setBusy(true);
    setError(null);
    const res = await bridge.apiKeys.create({
      label,
      scopes,
      expires_in_days: typeof expiresIn === "number" ? expiresIn : undefined
    });
    setBusy(false);
    if (res.ok) {
      setCreatedSecret(res.data as ApiKeyCreated);
      setShowForm(false);
      setLabel("");
      await load();
    } else {
      setError(res.error ?? null);
    }
  }

  async function revoke(id: string) {
    if (!confirm("Revoke this API key? Any client using it will stop working.")) return;
    setBusy(true);
    await bridge.apiKeys.revoke(id);
    await load();
    setBusy(false);
  }

  return (
    <div className="p-8 max-w-5xl mx-auto">
      <PageHeader
        title="API keys"
        subtitle="Programmatic access. Keys are stored hashed — you'll see the secret only once."
        action={
          <button onClick={() => setShowForm(true)} className="em-btn-primary">
            <Plus className="w-4 h-4" />
            Create key
          </button>
        }
      />

      {error && (
        <div className="text-sm text-danger-500 bg-danger-500/10 border border-danger-500/30 rounded-md p-3 mb-4">
          {error}
        </div>
      )}

      {createdSecret && (
        <div className="em-card border-brand-500/40 bg-brand-500/5 p-5 mb-4">
          <div className="flex items-center justify-between">
            <div>
              <div className="font-semibold">Key created — copy it now</div>
              <div className="text-xs text-ink-secondary">
                We don't store the plaintext. Store it in your secrets manager.
              </div>
            </div>
            <button
              onClick={async () => {
                await navigator.clipboard.writeText(createdSecret.api_key);
              }}
              className="em-btn-primary"
            >
              <Copy className="w-4 h-4" />
              Copy
            </button>
          </div>
          <pre className="mt-3 bg-bg-base p-3 rounded-md font-mono text-xs selectable break-all">
            {createdSecret.api_key}
          </pre>
          <button
            onClick={() => setCreatedSecret(null)}
            className="em-btn-ghost mt-3"
          >
            I've saved it, dismiss
          </button>
        </div>
      )}

      {showForm && (
        <div className="em-card p-5 mb-4 space-y-4">
          <div>
            <label className="em-label">Label</label>
            <input
              className="em-input"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder="e.g. ingest-pipeline-prod"
            />
          </div>
          <div>
            <label className="em-label">Scopes</label>
            <div className="flex flex-wrap gap-2">
              {SCOPES.map((s) => (
                <label
                  key={s}
                  className={`em-badge cursor-pointer ${
                    scopes.includes(s) ? "em-pill-active" : "em-pill-idle"
                  }`}
                >
                  <input
                    type="checkbox"
                    className="hidden"
                    checked={scopes.includes(s)}
                    onChange={(e) =>
                      setScopes((prev) =>
                        e.target.checked
                          ? [...prev, s]
                          : prev.filter((x) => x !== s)
                      )
                    }
                  />
                  {s}
                </label>
              ))}
            </div>
          </div>
          <div>
            <label className="em-label">Expires in (days)</label>
            <input
              type="number"
              min={1}
              max={3650}
              className="em-input w-[160px]"
              value={expiresIn}
              onChange={(e) =>
                setExpiresIn(e.target.value === "" ? "" : Number(e.target.value))
              }
              placeholder="optional"
            />
          </div>
          <div className="flex gap-2">
            <button
              disabled={!label || scopes.length === 0 || busy}
              onClick={() => void create()}
              className="em-btn-primary"
            >
              Create
            </button>
            <button onClick={() => setShowForm(false)} className="em-btn-ghost">
              Cancel
            </button>
          </div>
        </div>
      )}

      <div className="em-card overflow-hidden">
        {items.length === 0 ? (
          <div className="px-5 py-10 text-center text-sm text-ink-secondary">
            No API keys yet.
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead className="bg-bg-elev">
              <tr className="text-xs uppercase tracking-wider text-ink-secondary">
                <th className="text-left px-5 py-2 font-medium">Label</th>
                <th className="text-left px-5 py-2 font-medium">Prefix</th>
                <th className="text-left px-5 py-2 font-medium">Scopes</th>
                <th className="text-left px-5 py-2 font-medium">Status</th>
                <th className="text-right px-5 py-2 font-medium">Last used</th>
                <th className="text-right px-5 py-2 font-medium">Expires</th>
                <th className="text-right px-5 py-2 font-medium"></th>
              </tr>
            </thead>
            <tbody>
              {items.map((k) => (
                <tr key={k.id} className="border-t border-white/5">
                  <td className="px-5 py-3">{k.label}</td>
                  <td className="px-5 py-3 font-mono text-xs">{k.key_prefix}…</td>
                  <td className="px-5 py-3 text-xs">
                    {k.scopes.join(", ") || "—"}
                  </td>
                  <td className="px-5 py-3">
                    <span
                      className={
                        k.is_active && !k.revoked_at
                          ? "em-pill-active"
                          : "em-pill-danger"
                      }
                    >
                      {k.revoked_at ? "revoked" : k.is_active ? "active" : "inactive"}
                    </span>
                  </td>
                  <td className="px-5 py-3 text-right text-xs text-ink-secondary">
                    {fmtRelative(k.last_used_at)}
                  </td>
                  <td className="px-5 py-3 text-right text-xs text-ink-secondary">
                    {fmtRelative(k.expires_at)}
                  </td>
                  <td className="px-5 py-3 text-right">
                    {k.is_active && !k.revoked_at && (
                      <button
                        disabled={busy}
                        onClick={() => void revoke(k.id)}
                        className="text-danger-500 hover:text-danger-500/80"
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
