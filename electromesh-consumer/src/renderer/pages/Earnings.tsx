import { useEffect, useState } from "react";
import { useDashboard } from "../state/dashboard";
import { useAuth } from "../state/auth";
import { bridge } from "../api/bridge";
import { formatRelative, formatUsd } from "../lib/format";
import { StatusPill } from "../components/StatusPill";

interface LedgerEntry {
  id?: string;
  ts: string;
  kind: string;
  amount_cents: number;
  description?: string;
  device_label?: string;
}

export function Earnings() {
  const { snapshot, refresh } = useDashboard();
  const { user } = useAuth();
  const [ledger, setLedger] = useState<LedgerEntry[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void refresh();
    bridge.dashboard.earnings()
      .then((raw) => {
        const items = Array.isArray(raw)
          ? raw as LedgerEntry[]
          : (raw as { items?: LedgerEntry[] })?.items || [];
        setLedger(items);
      })
      .catch((err) => setError(err instanceof Error ? err.message : String(err)));
  }, [refresh]);

  const lifetime = snapshot?.total_earnings_cents ?? user?.total_earnings_cents ?? 0;
  const balance = snapshot?.wallet_balance_cents ?? user?.wallet_balance_cents ?? 0;
  const pending = snapshot?.payout_pending_cents ?? 0;

  return (
    <main className="page" data-fade>
      <header className="page-header">
        <div>
          <span className="page-header__eyebrow">Wallet · Earnings</span>
          <h1 className="page-header__title">Where the money came from.</h1>
          <p className="page-header__lede">
            Every workunit, bonus and adjustment that hit your wallet is here.
            Drill into a device to see only that device's ledger.
          </p>
        </div>
      </header>

      {error && <div className="auth-error">{error}</div>}

      <section className="kpi-strip">
        <div className="kpi">
          <span className="kpi__label">Lifetime earnings</span>
          <span className="kpi__value">{formatUsd(lifetime)}</span>
          <span className="kpi__hint">All devices</span>
        </div>
        <div className="kpi">
          <span className="kpi__label">Wallet balance</span>
          <span className="kpi__value">{formatUsd(balance)}</span>
          <span className="kpi__hint">Available now</span>
        </div>
        <div className="kpi">
          <span className="kpi__label">Pending payout</span>
          <span className="kpi__value">{formatUsd(pending)}</span>
          <span className="kpi__hint">{snapshot?.next_payout_at ? `Next ${formatRelative(snapshot.next_payout_at)}` : "No schedule"}</span>
        </div>
        <div className="kpi">
          <span className="kpi__label">Ledger entries</span>
          <span className="kpi__value">{ledger.length}</span>
          <span className="kpi__hint">Most recent first</span>
        </div>
      </section>

      <section className="section">
        <div className="section__head">
          <h2>Ledger</h2>
          <span className="rule" />
        </div>
        {ledger.length === 0 ? (
          <div className="empty">
            <div className="empty__title">Nothing yet</div>
            <p className="empty__lede">Your first workunit settle event will land here within minutes of going live.</p>
          </div>
        ) : (
          <table className="t-table">
            <thead>
              <tr>
                <th>When</th>
                <th>Kind</th>
                <th>Device</th>
                <th>Description</th>
                <th className="num">Amount</th>
              </tr>
            </thead>
            <tbody>
              {ledger.map((row, i) => (
                <tr key={row.id || i}>
                  <td className="nowrap">{formatRelative(row.ts)}</td>
                  <td><StatusPill tone="quiet" withDot={false}>{row.kind}</StatusPill></td>
                  <td>{row.device_label || "—"}</td>
                  <td>{row.description || ""}</td>
                  <td className="num">{formatUsd(row.amount_cents)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </main>
  );
}
