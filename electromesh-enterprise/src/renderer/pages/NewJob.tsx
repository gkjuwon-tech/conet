import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { ArrowLeft, ShieldCheck } from "lucide-react";
import { PageHeader } from "../components/PageHeader";
import { bridge } from "../api/bridge";
import { fmtH100, fmtUsd, JOB_KINDS } from "../lib/format";
import { useCart } from "../state/cart";

const CHARSETS = [
  { id: "lower", label: "lowercase (a-z)", value: "abcdefghijklmnopqrstuvwxyz" },
  {
    id: "alnum",
    label: "alphanumeric",
    value: "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"
  },
  { id: "digits", label: "digits (0-9)", value: "0123456789" },
  {
    id: "all",
    label: "common ascii",
    value:
      "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789!@#$%^&*"
  }
];

export function NewJob() {
  const nav = useNavigate();
  const cart = useCart();
  const [kind, setKind] = useState("hashcrack.range");
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [maxBudget, setMaxBudget] = useState(50);
  const [maxRuntimeMin, setMaxRuntimeMin] = useState(60);
  const [redundancy, setRedundancy] = useState(2);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [algorithm, setAlgorithm] = useState<"sha256" | "md5" | "sha512" | "ntlm">("sha256");
  const [targetHash, setTargetHash] = useState("");
  const [salt, setSalt] = useState("");
  const [charsetId, setCharsetId] = useState("lower");
  const [minLength, setMinLength] = useState(4);
  const [maxLength, setMaxLength] = useState(6);
  const [chunkSize, setChunkSize] = useState(1_000_000);
  const [wordlistUri, setWordlistUri] = useState("");

  const charset = CHARSETS.find((c) => c.id === charsetId)?.value ?? CHARSETS[0]!.value;

  useEffect(() => {
    if (cart.lines.length === 0) {
      setError("Add at least one cluster from the marketplace before submitting.");
    }
  }, [cart.lines]);

  async function submit() {
    setError(null);
    setBusy(true);
    const totals = cart.totals();
    const targetH100 = totals.h100Hours;

    const payload: Record<string, unknown> = {
      kind,
      title: title || undefined,
      description: description || undefined,
      target_cluster_count: cart.lines.length,
      target_h100_equivalent: targetH100,
      max_budget_cents: Math.max(100, Math.round(maxBudget * 100)),
      max_runtime_seconds: maxRuntimeMin * 60,
      redundancy,
      consensus_threshold: 0.66,
      isolation_policy: {
        forbid_plaintext: true,
        forbid_keys: true,
        chunk_only: true,
        require_attestation: false,
        encryption: "aes_gcm",
        redact_fields: []
      }
    };

    if (kind === "hashcrack.range") {
      payload.hashcrack_range = {
        algorithm,
        target_hash: targetHash.trim(),
        salt: salt || null,
        charset,
        min_length: minLength,
        max_length: maxLength,
        chunk_size: chunkSize
      };
    } else if (kind === "hashcrack.dict") {
      payload.hashcrack_dict = {
        algorithm,
        target_hash: targetHash.trim(),
        salt: salt || null,
        wordlist_uri: wordlistUri,
        chunk_size: chunkSize
      };
    } else {
      setError(`This wizard currently supports hashcrack.range and hashcrack.dict only.`);
      setBusy(false);
      return;
    }

    const res = await bridge.jobs.submit(payload);
    setBusy(false);
    if (res.ok) {
      cart.clear();
      const job = res.data as { id: string };
      nav(`/jobs/${job.id}`);
    } else {
      setError(res.error ?? "submission failed");
    }
  }

  return (
    <div className="p-8 max-w-4xl mx-auto">
      <button
        onClick={() => nav(-1)}
        className="flex items-center gap-1 text-sm text-ink-secondary hover:text-ink-primary mb-3"
      >
        <ArrowLeft className="w-4 h-4" />
        Back
      </button>

      <PageHeader
        title="Submit a job"
        subtitle="Compose a workload, attach clusters from your cart, and start running."
      />

      <div className="grid grid-cols-3 gap-4">
        <div className="col-span-2 space-y-4">
          <section className="em-card p-5 space-y-4">
            <div>
              <label className="em-label">Workload kind</label>
              <select
                className="em-input"
                value={kind}
                onChange={(e) => setKind(e.target.value)}
              >
                {JOB_KINDS.map((k) => (
                  <option key={k.id} value={k.id}>
                    {k.label}
                  </option>
                ))}
              </select>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="em-label">Title</label>
                <input
                  className="em-input"
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  placeholder="Optional"
                />
              </div>
              <div>
                <label className="em-label">Max runtime (minutes)</label>
                <input
                  type="number"
                  min={1}
                  max={1440}
                  className="em-input"
                  value={maxRuntimeMin}
                  onChange={(e) => setMaxRuntimeMin(Number(e.target.value) || 60)}
                />
              </div>
              <div>
                <label className="em-label">Max budget (USD)</label>
                <input
                  type="number"
                  min={1}
                  step={0.5}
                  className="em-input"
                  value={maxBudget}
                  onChange={(e) => setMaxBudget(Number(e.target.value) || 1)}
                />
              </div>
              <div>
                <label className="em-label">Redundancy (consensus copies)</label>
                <input
                  type="number"
                  min={1}
                  max={5}
                  className="em-input"
                  value={redundancy}
                  onChange={(e) => setRedundancy(Number(e.target.value) || 2)}
                />
              </div>
            </div>
            <div>
              <label className="em-label">Description</label>
              <textarea
                className="em-textarea"
                rows={2}
                value={description}
                onChange={(e) => setDescription(e.target.value)}
              />
            </div>
          </section>

          {(kind === "hashcrack.range" || kind === "hashcrack.dict") && (
            <section className="em-card p-5 space-y-4">
              <div className="text-sm font-semibold">Hash crack input</div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="em-label">Algorithm</label>
                  <select
                    className="em-input"
                    value={algorithm}
                    onChange={(e) =>
                      setAlgorithm(e.target.value as typeof algorithm)
                    }
                  >
                    <option value="sha256">SHA-256</option>
                    <option value="sha512">SHA-512</option>
                    <option value="md5">MD5</option>
                    <option value="ntlm">NTLM</option>
                  </select>
                </div>
                <div>
                  <label className="em-label">Salt (optional)</label>
                  <input
                    className="em-input font-mono"
                    value={salt}
                    onChange={(e) => setSalt(e.target.value)}
                  />
                </div>
                <div className="col-span-2">
                  <label className="em-label">Target hash (hex)</label>
                  <input
                    className="em-input font-mono"
                    value={targetHash}
                    onChange={(e) => setTargetHash(e.target.value)}
                    spellCheck={false}
                    placeholder="64 hex chars for SHA-256"
                  />
                </div>
              </div>

              {kind === "hashcrack.range" ? (
                <>
                  <div className="grid grid-cols-3 gap-3">
                    <div>
                      <label className="em-label">Charset</label>
                      <select
                        className="em-input"
                        value={charsetId}
                        onChange={(e) => setCharsetId(e.target.value)}
                      >
                        {CHARSETS.map((c) => (
                          <option key={c.id} value={c.id}>
                            {c.label}
                          </option>
                        ))}
                      </select>
                    </div>
                    <div>
                      <label className="em-label">Min length</label>
                      <input
                        type="number"
                        min={1}
                        max={32}
                        className="em-input"
                        value={minLength}
                        onChange={(e) => setMinLength(Number(e.target.value) || 4)}
                      />
                    </div>
                    <div>
                      <label className="em-label">Max length</label>
                      <input
                        type="number"
                        min={1}
                        max={32}
                        className="em-input"
                        value={maxLength}
                        onChange={(e) => setMaxLength(Number(e.target.value) || 6)}
                      />
                    </div>
                  </div>
                  <div>
                    <label className="em-label">Chunk size (keys per work-unit)</label>
                    <input
                      type="number"
                      min={10_000}
                      step={10_000}
                      className="em-input"
                      value={chunkSize}
                      onChange={(e) => setChunkSize(Number(e.target.value) || 1_000_000)}
                    />
                  </div>
                </>
              ) : (
                <div>
                  <label className="em-label">Wordlist URI</label>
                  <input
                    className="em-input"
                    placeholder="s3://bucket/list.txt"
                    value={wordlistUri}
                    onChange={(e) => setWordlistUri(e.target.value)}
                  />
                </div>
              )}
            </section>
          )}

          <section className="em-card p-5">
            <div className="flex items-center gap-2 text-sm">
              <ShieldCheck className="w-4 h-4 text-brand-500" />
              <span className="font-semibold">Isolation</span>
            </div>
            <ul className="mt-2 text-xs text-ink-secondary space-y-1">
              <li>• Plaintext rejected at submission</li>
              <li>• Each device receives a key-space chunk only — never the full target</li>
              <li>
                • {redundancy}× redundancy with 66% consensus before reward release
              </li>
              <li>• PII/secret patterns blocked by orchestrator</li>
            </ul>
          </section>
        </div>

        <aside className="space-y-4">
          <section className="em-card p-5">
            <div className="text-sm font-semibold mb-3">Attached clusters</div>
            {cart.lines.length === 0 ? (
              <div className="text-xs text-ink-secondary">
                No clusters attached. Browse the marketplace and add some.
              </div>
            ) : (
              <ul className="space-y-2">
                {cart.lines.map((l) => (
                  <li
                    key={l.cluster.id}
                    className="text-xs bg-bg-elev rounded-md p-2"
                  >
                    <div className="flex justify-between">
                      <span className="font-mono">{l.cluster.handle}</span>
                      <span className="font-mono">{l.hours}h</span>
                    </div>
                    <div className="text-ink-secondary">
                      {fmtH100(l.cluster.h100_equivalent)} ·{" "}
                      {fmtUsd(l.cluster.price_usd_per_hour * l.hours * 100)}
                    </div>
                  </li>
                ))}
              </ul>
            )}
            <button
              className="em-btn-ghost w-full mt-3"
              onClick={() => nav("/marketplace")}
            >
              {cart.lines.length === 0 ? "Browse marketplace" : "Add more"}
            </button>
          </section>

          <section className="em-card p-5">
            <div className="text-sm font-semibold mb-2">Estimate</div>
            <div className="text-xs text-ink-secondary">
              Target compute
            </div>
            <div className="font-mono text-lg">
              {fmtH100(cart.totals().h100Hours)} hr
            </div>
            <div className="text-xs text-ink-secondary mt-2">Cluster spend</div>
            <div className="font-mono text-lg">
              {fmtUsd(cart.totals().usd * 100)}
            </div>
            <div className="text-xs text-ink-secondary mt-2">Budget cap</div>
            <div className="font-mono">{fmtUsd(maxBudget * 100)}</div>
          </section>

          {error && (
            <div className="text-xs text-danger-500 bg-danger-500/10 border border-danger-500/30 rounded-md p-3">
              {error}
            </div>
          )}

          <button
            disabled={busy || cart.lines.length === 0 || !targetHash.trim()}
            onClick={() => void submit()}
            className="em-btn-primary w-full"
          >
            {busy ? "Submitting…" : "Submit job"}
          </button>
        </aside>
      </div>
    </div>
  );
}
