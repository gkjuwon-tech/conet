import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Search } from "lucide-react";
import { bridge } from "../api/bridge";
import { StatusPill } from "../components/StatusPill";
import { EmptyState } from "../components/EmptyState";
import { formatUsd } from "../lib/format";

interface Recipe {
  id: string;
  label: string;
  workload: string;
  description?: string;
  vendor?: string;
  estimated_cost_cents_per_unit?: number;
  estimated_throughput?: number;
  tags?: string[];
  visibility?: string;
}

export function Marketplace() {
  const nav = useNavigate();
  const [recipes, setRecipes] = useState<Recipe[]>([]);
  const [query, setQuery] = useState("");
  const [tag, setTag] = useState<string>("all");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    bridge.marketplace.list()
      .then((raw) => {
        if (cancelled) return;
        const items = Array.isArray(raw)
          ? raw as Recipe[]
          : (raw as { items?: Recipe[] })?.items || [];
        setRecipes(items);
      })
      .catch((err) => { if (!cancelled) setError(err instanceof Error ? err.message : String(err)); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, []);

  const allTags = useMemo(() => {
    const set = new Set<string>();
    for (const r of recipes) for (const t of r.tags || []) set.add(t);
    return ["all", ...Array.from(set).sort()];
  }, [recipes]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return recipes.filter((r) => {
      if (tag !== "all" && !(r.tags || []).includes(tag)) return false;
      if (!q) return true;
      return (
        r.label.toLowerCase().includes(q) ||
        (r.description || "").toLowerCase().includes(q) ||
        (r.vendor || "").toLowerCase().includes(q) ||
        r.workload.toLowerCase().includes(q)
      );
    });
  }, [recipes, query, tag]);

  return (
    <main className="page" data-fade>
      <header className="page-header">
        <div>
          <span className="page-header__eyebrow">Workload · Marketplace</span>
          <h1 className="page-header__title">Ready-made workloads.</h1>
          <p className="page-header__lede">
            Browse curated recipes published by ElectroMesh and verified
            partners. Each recipe is parameterised — pick one and you'll be
            asked for the inputs that matter.
          </p>
        </div>
      </header>

      <div className="devices-toolbar">
        <div className="cluster">
          <Search size={14} aria-hidden style={{ opacity: 0.5 }} />
          <input
            className="search"
            placeholder="Search by name, vendor, workload"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
        <div className="grow" />
        <div className="segmented" style={{ flexWrap: "wrap" }}>
          {allTags.map((t) => (
            <button key={t} type="button" className={tag === t ? "is-active" : ""} onClick={() => setTag(t)}>
              {t}
            </button>
          ))}
        </div>
      </div>

      {error && <div className="auth-error">{error}</div>}

      {loading ? (
        <div className="empty"><span className="spinner" aria-hidden /> Loading recipes…</div>
      ) : filtered.length === 0 ? (
        <EmptyState
          title="No recipes match your filter"
          body="Try widening the search, or contact ElectroMesh sales for custom workload onboarding."
        />
      ) : (
        <div className="marketplace-grid">
          {filtered.map((r) => (
            <article key={r.id} className="recipe-card" onClick={() => nav(`/jobs/new?recipe=${encodeURIComponent(r.id)}`)}>
              <header className="recipe-card__head">
                <strong>{r.label}</strong>
                <span className="mono">{r.workload}</span>
              </header>
              <p className="recipe-card__lede">{r.description || "No description provided."}</p>
              <dl className="recipe-card__metrics">
                <div><dt>Est. cost / unit</dt><dd>{formatUsd(r.estimated_cost_cents_per_unit ?? 0)}</dd></div>
                <div><dt>Throughput</dt><dd>{r.estimated_throughput ?? "—"}</dd></div>
                <div><dt>Vendor</dt><dd>{r.vendor ?? "ElectroMesh"}</dd></div>
              </dl>
              <footer className="recipe-card__foot">
                {(r.tags || []).slice(0, 4).map((t) => (
                  <StatusPill key={t} tone="quiet" withDot={false}>{t}</StatusPill>
                ))}
                <span className="grow" />
                <span className="recipe-card__cta">Configure →</span>
              </footer>
            </article>
          ))}
        </div>
      )}
    </main>
  );
}
