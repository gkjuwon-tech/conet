import { useEffect, useState } from "react";
import { PageHeader } from "../components/PageHeader";
import { StatCard } from "../components/StatCard";
import { bridge } from "../api/bridge";
import { fmtRelative, fmtUsd } from "../lib/format";
import { useDashboard } from "../state/dashboard";

interface LedgerEntry {
  id: string;
  amount_cents: number;
  occurred_at: string;
  note: string | null;
  job_id: string | null;
  workunit_id: string | null;
  device_id: string | null;
}

export function Earnings() {
  const [entries, setEntries] = useState<LedgerEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { snapshot, refresh } = useDashboard();

  useEffect(() => {
    void refresh();
    void loadLedger();
  }, [refresh]);

  async function loadLedger() {
    setLoading(true);
    setError(null);
    const res = await bridge.apiCall({ path: "/v1/payouts" });
    if (res.ok) {
      const items = (res.data as { items: { id: string }[] }).items;
      const entries: LedgerEntry[] = [];
      for (const p of items.slice(0, 5)) {
        const ledger = await bridge.apiCall({
          path: `/v1/payouts/${p.id}/ledger`
        });
        if (ledger.ok) {
          entries.push(...((ledger.data as LedgerEntry[]) ?? []));
        }
      }
      setEntries(entries);
    } else {
      setError(res.error ?? "ledger failed");
    }
    setLoading(false);
  }

  return (
    <div className="p-8 max-w-5xl mx-auto">
      <PageHeader
        title="Earnings"
        subtitle="Every accepted workunit is logged here, broken down per job and device."
      />
      <div className="grid grid-cols-3 gap-4 mb-6">
        <StatCard
          label="Available"
          value={fmtUsd(snapshot?.wallet.available_cents ?? 0)}
          accent="brand"
        />
        <StatCard
          label="Lifetime earned"
          value={fmtUsd(snapshot?.wallet.lifetime_earned_cents ?? 0)}
        />
        <StatCard
          label="Lifetime paid"
          value={fmtUsd(snapshot?.wallet.lifetime_paid_cents ?? 0)}
        />
      </div>

      <section className="em-card overflow-hidden">
        <div className="px-5 py-4 border-b border-white/5 text-sm font-medium">
          Ledger
        </div>
        {loading && (
          <div className="px-5 py-3 text-xs text-ink-secondary">Loading…</div>
        )}
        {error && (
          <div className="px-5 py-3 text-sm text-danger-500">{error}</div>
        )}
        {!loading && entries.length === 0 && !error && (
          <div className="px-5 py-10 text-center text-sm text-ink-secondary">
            No ledger entries yet — your first earnings will land here once
            a job settles.
          </div>
        )}
        {entries.length > 0 && (
          <table className="w-full text-sm">
            <thead className="bg-bg-elev">
              <tr className="text-xs uppercase tracking-wider text-ink-secondary">
                <th className="text-left px-5 py-2 font-medium">When</th>
                <th className="text-left px-5 py-2 font-medium">Job</th>
                <th className="text-left px-5 py-2 font-medium">Device</th>
                <th className="text-left px-5 py-2 font-medium">Note</th>
                <th className="text-right px-5 py-2 font-medium">Amount</th>
              </tr>
            </thead>
            <tbody>
              {entries.map((e) => (
                <tr key={e.id} className="border-t border-white/5">
                  <td className="px-5 py-3 text-ink-secondary text-xs">
                    {fmtRelative(e.occurred_at)}
                  </td>
                  <td className="px-5 py-3 font-mono text-xs truncate max-w-[160px]">
                    {e.job_id ?? "—"}
                  </td>
                  <td className="px-5 py-3 font-mono text-xs truncate max-w-[160px]">
                    {e.device_id ?? "—"}
                  </td>
                  <td className="px-5 py-3 text-xs">{e.note ?? ""}</td>
                  <td className="px-5 py-3 text-right font-mono">
                    {fmtUsd(e.amount_cents)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}
