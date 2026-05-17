import { useEffect, useState } from "react";
import { Banknote } from "lucide-react";
import { PageHeader } from "../components/PageHeader";
import { bridge } from "../api/bridge";
import { fmtRelative, fmtUsd } from "../lib/format";
import { useDashboard } from "../state/dashboard";

interface PayoutItem {
  id: string;
  handle: string;
  amount_cents: number;
  currency: string;
  status: string;
  period_start: string;
  period_end: string;
  method: string;
  initiated_at: string | null;
  settled_at: string | null;
  failure_reason: string | null;
}

export function Payouts() {
  const [items, setItems] = useState<PayoutItem[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const { snapshot, refresh } = useDashboard();

  useEffect(() => {
    void load();
    void refresh();
  }, [refresh]);

  async function load() {
    const res = await bridge.apiCall({ path: "/v1/payouts" });
    if (res.ok) {
      setItems(((res.data as { items: PayoutItem[] }).items as PayoutItem[]) ?? []);
    } else {
      setError(res.error ?? null);
    }
  }

  async function requestPayout() {
    setBusy(true);
    setError(null);
    setInfo(null);
    const res = await bridge.payouts.request();
    setBusy(false);
    if (res.ok) {
      setInfo(`Payout ${(res.payout as PayoutItem).handle} queued for ${fmtUsd((res.payout as PayoutItem).amount_cents)}.`);
      await refresh();
      await load();
    } else {
      setError(res.error ?? "failed");
    }
  }

  const available = snapshot?.wallet.available_cents ?? 0;

  return (
    <div className="p-8 max-w-5xl mx-auto">
      <PageHeader
        title="Payouts"
        subtitle="Move your wallet balance to your payout method."
        action={
          <button
            disabled={busy || available < 100}
            onClick={() => void requestPayout()}
            className="em-btn-primary"
          >
            <Banknote className="w-4 h-4" />
            Request {fmtUsd(available)}
          </button>
        }
      />

      {info && (
        <div className="text-sm text-brand-400 bg-brand-500/10 border border-brand-500/30 rounded-md p-3 mb-4">
          {info}
        </div>
      )}
      {error && (
        <div className="text-sm text-danger-500 bg-danger-500/10 border border-danger-500/30 rounded-md p-3 mb-4">
          {error}
        </div>
      )}

      <div className="em-card overflow-hidden">
        {items.length === 0 ? (
          <div className="px-5 py-10 text-center text-sm text-ink-secondary">
            No payouts yet. Once your balance is at least $1.00 you can request
            a transfer.
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead className="bg-bg-elev">
              <tr className="text-xs uppercase tracking-wider text-ink-secondary">
                <th className="text-left px-5 py-2 font-medium">Handle</th>
                <th className="text-left px-5 py-2 font-medium">Status</th>
                <th className="text-left px-5 py-2 font-medium">Period</th>
                <th className="text-left px-5 py-2 font-medium">Method</th>
                <th className="text-right px-5 py-2 font-medium">Amount</th>
                <th className="text-right px-5 py-2 font-medium">Settled</th>
              </tr>
            </thead>
            <tbody>
              {items.map((p) => (
                <tr key={p.id} className="border-t border-white/5">
                  <td className="px-5 py-3 font-mono text-xs">{p.handle}</td>
                  <td className="px-5 py-3">
                    <span
                      className={
                        p.status === "paid"
                          ? "em-pill-active"
                          : p.status === "failed"
                            ? "em-pill-danger"
                            : "em-pill-warn"
                      }
                    >
                      {p.status}
                    </span>
                  </td>
                  <td className="px-5 py-3 text-xs">
                    {fmtRelative(p.period_start)} → {fmtRelative(p.period_end)}
                  </td>
                  <td className="px-5 py-3 text-xs capitalize">{p.method}</td>
                  <td className="px-5 py-3 text-right font-mono">
                    {fmtUsd(p.amount_cents)}
                  </td>
                  <td className="px-5 py-3 text-right text-xs text-ink-secondary">
                    {fmtRelative(p.settled_at)}
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
