import { useEffect, useState } from "react";
import { useDashboard } from "../state/dashboard";
import { useAuth } from "../state/auth";
import { bridge } from "../api/bridge";
import { formatRelative, formatUsd } from "../lib/format";
import { StatusPill } from "../components/StatusPill";

interface PayoutRow {
  id: string;
  requested_at: string;
  settled_at?: string | null;
  amount_cents: number;
  state: string;
  destination?: string;
  fee_cents?: number;
}

export function Payouts() {
  const { snapshot, refresh } = useDashboard();
  const { user } = useAuth();
  const [items, setItems] = useState<PayoutRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function load() {
    try {
      const raw = await bridge.dashboard.earnings();
      const list = Array.isArray(raw) ? raw as PayoutRow[] : (raw as { items?: PayoutRow[] })?.items || [];
      setItems(list);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  useEffect(() => {
    void refresh();
    void load();
  }, [refresh]);

  async function requestPayout() {
    setBusy(true); setError(null);
    try {
      await bridge.dashboard.payoutRequest();
      await refresh();
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  const balance = snapshot?.wallet_balance_cents ?? user?.wallet_balance_cents ?? 0;
  const pending = snapshot?.payout_pending_cents ?? 0;

  return (
    <main className="page" data-fade>
      <header className="page-header">
        <div>
          <span className="page-header__eyebrow">Wallet · Payouts</span>
          <h1 className="page-header__title">Cash out your wallet.</h1>
          <p className="page-header__lede">
            Request a payout any time your wallet has a balance. Payouts settle
            to your configured payment method (configure in Settings · Wallet).
          </p>
        </div>
        <div className="page-header__actions">
          <button
            type="button"
            className="btn btn--primary"
            disabled={busy || balance <= 0}
            onClick={() => void requestPayout()}
          >
            {busy ? "Requesting…" : `Request payout (${formatUsd(balance)})`}
          </button>
        </div>
      </header>

      {error && <div className="auth-error">{error}</div>}

      <section className="kpi-strip">
        <div className="kpi">
          <span className="kpi__label">Available now</span>
          <span className="kpi__value">{formatUsd(balance)}</span>
          <span className="kpi__hint">Wallet balance</span>
        </div>
        <div className="kpi">
          <span className="kpi__label">In flight</span>
          <span className="kpi__value">{formatUsd(pending)}</span>
          <span className="kpi__hint">Pending settlement</span>
        </div>
        <div className="kpi">
          <span className="kpi__label">Lifetime payouts</span>
          <span className="kpi__value">
            {formatUsd(items.filter((p) => p.state === "settled").reduce((acc, p) => acc + p.amount_cents, 0))}
          </span>
          <span className="kpi__hint">Settled to your account</span>
        </div>
      </section>

      <section className="section">
        <div className="section__head">
          <h2>History</h2>
          <span className="rule" />
        </div>
        {items.length === 0 ? (
          <div className="empty">
            <div className="empty__title">No payouts yet</div>
            <p className="empty__lede">When you cash out, the request and its settlement will live here.</p>
          </div>
        ) : (
          <table className="t-table">
            <thead>
              <tr>
                <th>Requested</th>
                <th>Settled</th>
                <th>State</th>
                <th>Destination</th>
                <th className="num">Fee</th>
                <th className="num">Amount</th>
              </tr>
            </thead>
            <tbody>
              {items.map((p) => (
                <tr key={p.id}>
                  <td className="nowrap">{formatRelative(p.requested_at)}</td>
                  <td className="nowrap">{p.settled_at ? formatRelative(p.settled_at) : "—"}</td>
                  <td>
                    <StatusPill tone={p.state === "settled" ? "ok" : p.state === "failed" ? "danger" : "quiet"}>
                      {p.state}
                    </StatusPill>
                  </td>
                  <td>{p.destination || "—"}</td>
                  <td className="num">{formatUsd(p.fee_cents ?? 0)}</td>
                  <td className="num">{formatUsd(p.amount_cents)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </main>
  );
}
