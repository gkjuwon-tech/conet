import { useEffect, useMemo, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import {
  ShoppingCart,
  Filter,
  X,
  Sparkles,
  ChevronDown
} from "lucide-react";
import { PageHeader } from "../components/PageHeader";
import { bridge, type ClusterCard, type MarketplacePage } from "../api/bridge";
import {
  fmtH100,
  fmtMb,
  fmtNumber,
  fmtPct,
  fmtRate,
  fmtUsd
} from "../lib/format";
import { useCart } from "../state/cart";

type Sort =
  | "price_asc"
  | "price_desc"
  | "h100_desc"
  | "reliability_desc"
  | "newest";

export function Marketplace() {
  const nav = useNavigate();
  const [params] = useSearchParams();
  const [items, setItems] = useState<ClusterCard[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sort, setSort] = useState<Sort>("price_asc");
  const [minH100, setMinH100] = useState<string>("");
  const [maxPrice, setMaxPrice] = useState<string>("");
  const [minReliability, setMinReliability] = useState<string>("");
  const [showCart, setShowCart] = useState(params.get("cart") === "1");

  const cart = useCart();

  useEffect(() => {
    void runSearch();
  }, [sort]);

  async function runSearch() {
    setLoading(true);
    setError(null);
    const filt: Record<string, unknown> = { sort, limit: 50 };
    if (minH100) filt.min_h100_equivalent = Number(minH100);
    if (maxPrice) filt.max_price_usd_hour = Number(maxPrice);
    if (minReliability) filt.min_reliability = Number(minReliability);

    const res = await bridge.marketplace.search(filt);
    setLoading(false);
    if (res.ok) {
      const page = res.data as MarketplacePage;
      setItems(page.items);
      setTotal(page.total_estimate);
    } else {
      setError(res.error ?? "search failed");
    }
  }

  return (
    <div className="p-8 max-w-7xl mx-auto">
      <PageHeader
        title="Marketplace"
        subtitle={`${total.toLocaleString()} clusters available · pricing per cluster mix`}
        action={
          <div className="flex gap-2">
            {cart.lines.length > 0 && (
              <button
                onClick={() => setShowCart(true)}
                className="em-btn-primary"
              >
                <ShoppingCart className="w-4 h-4" />
                Cart ({cart.lines.length})
              </button>
            )}
          </div>
        }
      />

      <Filters
        sort={sort}
        setSort={setSort}
        minH100={minH100}
        setMinH100={setMinH100}
        maxPrice={maxPrice}
        setMaxPrice={setMaxPrice}
        minReliability={minReliability}
        setMinReliability={setMinReliability}
        onApply={() => void runSearch()}
      />

      {error && (
        <div className="text-sm text-danger-500 bg-danger-500/10 border border-danger-500/30 rounded-md p-3 my-4">
          {error}
        </div>
      )}

      {loading ? (
        <div className="text-sm text-ink-secondary py-10">Loading…</div>
      ) : (
        <div className="grid grid-cols-2 gap-4">
          {items.map((c) => (
            <ClusterTile key={c.id} cluster={c} />
          ))}
          {items.length === 0 && (
            <div className="col-span-2 em-card p-10 text-center">
              <Sparkles className="w-8 h-8 text-ink-secondary mx-auto mb-2" />
              <div className="text-sm text-ink-secondary">
                No clusters match these filters yet.
              </div>
            </div>
          )}
        </div>
      )}

      {showCart && <CartDrawer onClose={() => setShowCart(false)} onCheckout={() => nav("/jobs/new")} />}
    </div>
  );
}

function Filters({
  sort,
  setSort,
  minH100,
  setMinH100,
  maxPrice,
  setMaxPrice,
  minReliability,
  setMinReliability,
  onApply
}: {
  sort: Sort;
  setSort: (s: Sort) => void;
  minH100: string;
  setMinH100: (v: string) => void;
  maxPrice: string;
  setMaxPrice: (v: string) => void;
  minReliability: string;
  setMinReliability: (v: string) => void;
  onApply: () => void;
}) {
  return (
    <div className="em-card p-4 mb-6 flex flex-wrap items-end gap-3">
      <div className="flex items-center gap-2 text-xs text-ink-secondary">
        <Filter className="w-3 h-3" />
        Filters
      </div>
      <div>
        <label className="em-label">Sort</label>
        <select
          className="em-input w-[180px]"
          value={sort}
          onChange={(e) => setSort(e.target.value as Sort)}
        >
          <option value="price_asc">Price (low → high)</option>
          <option value="price_desc">Price (high → low)</option>
          <option value="h100_desc">Most H100-equivalent</option>
          <option value="reliability_desc">Most reliable</option>
          <option value="newest">Newest</option>
        </select>
      </div>
      <div>
        <label className="em-label">Min H100-eq</label>
        <input
          className="em-input w-[120px]"
          value={minH100}
          onChange={(e) => setMinH100(e.target.value)}
          placeholder="e.g. 0.1"
        />
      </div>
      <div>
        <label className="em-label">Max $/hr</label>
        <input
          className="em-input w-[120px]"
          value={maxPrice}
          onChange={(e) => setMaxPrice(e.target.value)}
          placeholder="e.g. 5"
        />
      </div>
      <div>
        <label className="em-label">Min reliability</label>
        <input
          className="em-input w-[120px]"
          value={minReliability}
          onChange={(e) => setMinReliability(e.target.value)}
          placeholder="0–1"
        />
      </div>
      <button onClick={onApply} className="em-btn-primary">
        Apply
      </button>
    </div>
  );
}

function ClusterTile({ cluster }: { cluster: ClusterCard }) {
  const cart = useCart();
  const [hours, setHours] = useState("1");
  const [showComposition, setShowComposition] = useState(false);
  const inCart = cart.lines.some((l) => l.cluster.id === cluster.id);
  const compositionEntries = Object.entries(cluster.composition ?? {})
    .filter(([, n]) => n)
    .sort((a, b) => b[1] - a[1]);

  return (
    <div className="em-card p-5">
      <div className="flex items-start justify-between mb-3">
        <div className="min-w-0">
          <div className="font-mono text-xs text-ink-secondary">{cluster.handle}</div>
          <div className="font-semibold text-lg">{fmtH100(cluster.h100_equivalent)}</div>
        </div>
        <div className="text-right">
          <div className="font-mono text-base">{fmtRate(cluster.price_usd_per_hour)}</div>
          <div className="text-[11px] text-ink-secondary">
            {fmtPct(cluster.reliability_score)} reliable
          </div>
        </div>
      </div>

      <dl className="grid grid-cols-3 gap-3 text-xs mb-3">
        <Stat label="Members" value={`${cluster.member_count}`} />
        <Stat label="RAM" value={fmtMb(cluster.aggregate_ram_mb)} />
        <Stat label="VRAM" value={fmtMb(cluster.aggregate_vram_mb)} />
        <Stat label="CPU GFLOPS" value={fmtNumber(cluster.aggregate_cpu_gflops, 0)} />
        <Stat label="GPU GFLOPS" value={fmtNumber(cluster.aggregate_gpu_gflops, 0)} />
        <Stat label="Network" value={`${fmtNumber(cluster.aggregate_network_mbps, 0)} Mbps`} />
      </dl>

      <button
        onClick={() => setShowComposition((v) => !v)}
        className="text-[11px] text-ink-secondary hover:text-ink-primary flex items-center gap-1 mb-2"
      >
        <ChevronDown
          className={`w-3 h-3 transition-transform ${showComposition ? "rotate-180" : ""}`}
        />
        Mix · {compositionEntries.length} device classes
      </button>

      {showComposition && (
        <div className="bg-bg-elev rounded-lg p-3 mb-3 grid grid-cols-3 gap-1 text-xs">
          {compositionEntries.map(([cls, n]) => (
            <div key={cls} className="flex justify-between">
              <span className="text-ink-secondary truncate mr-2">{cls.replace(/_/g, " ")}</span>
              <span className="font-mono">{n}</span>
            </div>
          ))}
        </div>
      )}

      <div className="flex items-center gap-2">
        <input
          type="number"
          step={0.1}
          min={0.1}
          value={hours}
          onChange={(e) => setHours(e.target.value)}
          className="em-input w-[110px]"
        />
        <span className="text-xs text-ink-secondary">hours</span>
        <div className="ml-auto text-sm font-mono">
          {fmtUsd(cluster.price_usd_per_hour * Number(hours || 0) * 100)}
        </div>
      </div>

      <button
        disabled={inCart}
        onClick={() => cart.add(cluster, Number(hours) || 1)}
        className={inCart ? "em-btn-ghost w-full mt-3" : "em-btn-primary w-full mt-3"}
      >
        {inCart ? "Added to cart" : "Add to cart"}
      </button>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-[10px] uppercase tracking-wider text-ink-secondary">
        {label}
      </dt>
      <dd className="font-mono text-xs">{value}</dd>
    </div>
  );
}

function CartDrawer({
  onClose,
  onCheckout
}: {
  onClose: () => void;
  onCheckout: () => void;
}) {
  const cart = useCart();
  const totals = useCart((s) => s.totals());
  const lines = cart.lines;

  return (
    <div className="fixed inset-0 z-30 bg-black/60 grid place-items-end" onClick={onClose}>
      <div
        className="w-[480px] h-full bg-bg-card border-l border-white/5 flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-5 py-4 flex items-center justify-between border-b border-white/5">
          <div className="font-semibold">Cart</div>
          <button onClick={onClose} className="text-ink-secondary hover:text-ink-primary">
            <X className="w-5 h-5" />
          </button>
        </div>
        <div className="flex-1 overflow-auto px-5 py-4 space-y-3">
          {lines.length === 0 && (
            <div className="text-sm text-ink-secondary text-center py-12">
              Your cart is empty.
            </div>
          )}
          {lines.map((l) => (
            <div key={l.cluster.id} className="bg-bg-elev rounded-lg p-3">
              <div className="flex justify-between">
                <div className="font-mono text-xs text-ink-secondary">
                  {l.cluster.handle}
                </div>
                <button
                  onClick={() => cart.remove(l.cluster.id)}
                  className="text-ink-secondary hover:text-danger-500"
                >
                  <X className="w-3.5 h-3.5" />
                </button>
              </div>
              <div className="font-medium">{fmtH100(l.cluster.h100_equivalent)}</div>
              <div className="flex items-center gap-2 mt-2">
                <input
                  type="number"
                  min={0.1}
                  step={0.1}
                  value={l.hours}
                  onChange={(e) =>
                    cart.setHours(l.cluster.id, Number(e.target.value) || 0.1)
                  }
                  className="em-input w-[100px]"
                />
                <span className="text-xs text-ink-secondary">hours</span>
                <span className="ml-auto font-mono text-sm">
                  {fmtUsd(l.cluster.price_usd_per_hour * l.hours * 100)}
                </span>
              </div>
            </div>
          ))}
        </div>
        <div className="border-t border-white/5 px-5 py-4 space-y-3 bg-bg-elev">
          <Row label="Total" value={fmtUsd(totals.usd * 100)} bold />
          <Row label="Total H100-hours" value={`${totals.h100Hours.toFixed(2)}`} />
          <button
            disabled={lines.length === 0}
            onClick={onCheckout}
            className="em-btn-primary w-full"
          >
            Submit job with these clusters →
          </button>
          <button onClick={cart.clear} className="em-btn-ghost w-full">
            Clear cart
          </button>
        </div>
      </div>
    </div>
  );
}

function Row({ label, value, bold }: { label: string; value: string; bold?: boolean }) {
  return (
    <div className="flex justify-between text-sm">
      <span className="text-ink-secondary">{label}</span>
      <span className={`font-mono ${bold ? "font-semibold text-base" : ""}`}>
        {value}
      </span>
    </div>
  );
}
