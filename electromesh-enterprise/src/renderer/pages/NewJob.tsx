import { useEffect, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { bridge } from "../api/bridge";

interface Recipe {
  id: string;
  label: string;
  workload: string;
  description?: string;
  parameters?: Array<{
    name: string;
    label?: string;
    type?: "string" | "number" | "select";
    default?: unknown;
    required?: boolean;
    options?: Array<{ value: string; label: string }>;
    hint?: string;
  }>;
  estimated_cost_cents_per_unit?: number;
}

export function NewJob() {
  const nav = useNavigate();
  const [params] = useSearchParams();
  const recipeId = params.get("recipe");
  const [recipe, setRecipe] = useState<Recipe | null>(null);
  const [label, setLabel] = useState("");
  const [units, setUnits] = useState(100);
  const [maxCost, setMaxCost] = useState(1000);
  const [region, setRegion] = useState("asia-northeast");
  const [fields, setFields] = useState<Record<string, unknown>>({});
  const [loading, setLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!recipeId) return;
    setLoading(true);
    bridge.marketplace.item(recipeId)
      .then((raw) => {
        const r = raw as Recipe;
        setRecipe(r);
        setLabel(r.label);
        const init: Record<string, unknown> = {};
        for (const p of r.parameters || []) {
          init[p.name] = p.default ?? "";
        }
        setFields(init);
      })
      .catch((err) => setError(err instanceof Error ? err.message : String(err)))
      .finally(() => setLoading(false));
  }, [recipeId]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true); setError(null);
    try {
      const payload: Record<string, unknown> = {
        label: label.trim(),
        workunits_total: units,
        max_cost_cents: maxCost * 100,
        region,
        parameters: fields
      };
      if (recipe) {
        payload.recipe_id = recipe.id;
        payload.workload = recipe.workload;
      }
      const res = await bridge.jobs.create(payload) as { id?: string };
      if (res?.id) nav(`/jobs/${res.id}`);
      else nav("/jobs");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <main className="page" data-fade>
      <header className="page-header">
        <div>
          <span className="page-header__eyebrow">Jobs · New</span>
          <h1 className="page-header__title">{recipe ? `Configure ${recipe.label}` : "Custom job"}</h1>
          <p className="page-header__lede">
            {recipe
              ? recipe.description || "Provide the parameters this workload needs and we'll submit it."
              : "Define an ad-hoc workload from scratch — give it a label, set a unit budget, and submit."}
          </p>
        </div>
      </header>

      {error && <div className="auth-error">{error}</div>}
      {loading && <div className="empty"><span className="spinner" aria-hidden /> Loading recipe…</div>}

      <form className="job-form" onSubmit={submit}>
        <section className="form-section">
          <h2>Job</h2>
          <div className="field">
            <label htmlFor="label">Label</label>
            <input
              id="label"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              required
              placeholder={recipe?.label || "My batch"}
            />
            <span className="field-hint">Shown in the dashboard and on invoices.</span>
          </div>

          <div className="field-row">
            <div className="field">
              <label htmlFor="units">Workunits</label>
              <input
                id="units"
                type="number"
                min={1}
                value={units}
                onChange={(e) => setUnits(Math.max(1, Number(e.target.value)))}
              />
              <span className="field-hint">Discrete tasks to run in parallel.</span>
            </div>
            <div className="field">
              <label htmlFor="cost">Max cost (USD)</label>
              <input
                id="cost"
                type="number"
                min={1}
                value={maxCost}
                onChange={(e) => setMaxCost(Math.max(1, Number(e.target.value)))}
              />
              <span className="field-hint">Hard cap. Workload pauses if exceeded.</span>
            </div>
            <div className="field">
              <label htmlFor="region">Region</label>
              <select id="region" value={region} onChange={(e) => setRegion(e.target.value)}>
                <option value="asia-northeast">Asia · Northeast</option>
                <option value="americas-east">Americas · East</option>
                <option value="europe-west">Europe · West</option>
                <option value="global">Global pool</option>
              </select>
            </div>
          </div>
        </section>

        {recipe?.parameters && recipe.parameters.length > 0 && (
          <section className="form-section">
            <h2>Recipe parameters</h2>
            {recipe.parameters.map((p) => (
              <div key={p.name} className="field">
                <label htmlFor={`p-${p.name}`}>
                  {p.label || p.name}
                  {p.required && <span className="required"> *</span>}
                </label>
                {p.type === "select" ? (
                  <select
                    id={`p-${p.name}`}
                    value={String(fields[p.name] ?? "")}
                    onChange={(e) => setFields((f) => ({ ...f, [p.name]: e.target.value }))}
                  >
                    {(p.options || []).map((o) => (
                      <option key={o.value} value={o.value}>{o.label}</option>
                    ))}
                  </select>
                ) : (
                  <input
                    id={`p-${p.name}`}
                    type={p.type === "number" ? "number" : "text"}
                    value={String(fields[p.name] ?? "")}
                    onChange={(e) => setFields((f) => ({
                      ...f,
                      [p.name]: p.type === "number" ? Number(e.target.value) : e.target.value
                    }))}
                  />
                )}
                {p.hint && <span className="field-hint">{p.hint}</span>}
              </div>
            ))}
          </section>
        )}

        <div className="wizard-actions">
          <span className="wizard-actions__hint">
            {recipe?.estimated_cost_cents_per_unit
              ? `Estimated cost · $${((recipe.estimated_cost_cents_per_unit * units) / 100).toFixed(2)}`
              : "Custom workload — cost is uncapped beyond your max budget."}
          </span>
          <button type="button" className="btn btn--ghost" onClick={() => nav(-1)}>Cancel</button>
          <button type="submit" className="btn btn--primary" disabled={submitting}>
            {submitting ? "Submitting…" : "Submit job"}
          </button>
        </div>
      </form>
    </main>
  );
}
