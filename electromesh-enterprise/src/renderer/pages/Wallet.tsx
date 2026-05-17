import { useEffect, useState } from "react";
import { bridge } from "../api/bridge";
import { StatusPill } from "../components/StatusPill";
import { EmptyState } from "../components/EmptyState";
import { Modal } from "../components/Modal";
import { formatRelative, formatUsd } from "../lib/format";

interface WalletInfo {
  balance_cents?: number;
  pending_cents?: number;
  spend_30d_cents?: number;
}

interface Invoice {
  id: string;
  issued_at: string;
  due_at?: string;
  state: string;
  total_cents: number;
  paid_at?: string | null;
}

export function Wallet() {
  const [wallet, setWallet] = useState<WalletInfo | null>(null);
  const [invoices, setInvoices] = useState<Invoice[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [depositing, setDepositing] = useState(false);
  const [depositAmount, setDepositAmount] = useState(50);
  const [submitting, setSubmitting] = useState(false);

  async function refresh() {
    try {
      const [w, inv] = await Promise.all([
        bridge.wallet.balance(),
        bridge.wallet.invoices()
      ]);
      setWallet(w as WalletInfo);
      const items = Array.isArray(inv) ? inv as Invoice[] : (inv as { items?: Invoice[] })?.items || [];
      setInvoices(items);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  useEffect(() => { void refresh(); }, []);

  async function deposit() {
    if (depositAmount <= 0) return;
    setSubmitting(true); setError(null);
    try {
      await bridge.wallet.deposit({ amount_cents: Math.round(depositAmount * 100) });
      setDepositing(false);
      await refresh();
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
          <span className="page-header__eyebrow">Account · Wallet</span>
          <h1 className="page-header__title">Spending account</h1>
          <p className="page-header__lede">
            Top up your wallet, see what's in flight, and download invoices for
            accounting.
          </p>
        </div>
        <div className="page-header__actions">
          <button type="button" className="btn btn--primary" onClick={() => setDepositing(true)}>Deposit funds</button>
        </div>
      </header>

      {error && <div className="auth-error">{error}</div>}

      <section className="kpi-strip">
        <div className="kpi">
          <span className="kpi__label">Balance</span>
          <span className="kpi__value">{formatUsd(wallet?.balance_cents ?? 0)}</span>
          <span className="kpi__hint">Available now</span>
        </div>
        <div className="kpi">
          <span className="kpi__label">Pending</span>
          <span className="kpi__value">{formatUsd(wallet?.pending_cents ?? 0)}</span>
          <span className="kpi__hint">In-flight commitments</span>
        </div>
        <div className="kpi">
          <span className="kpi__label">30d spend</span>
          <span className="kpi__value">{formatUsd(wallet?.spend_30d_cents ?? 0)}</span>
          <span className="kpi__hint">All workloads</span>
        </div>
        <div className="kpi">
          <span className="kpi__label">Invoices</span>
          <span className="kpi__value">{invoices.length}</span>
          <span className="kpi__hint">{invoices.filter((i) => i.state !== "paid").length} open</span>
        </div>
      </section>

      <section className="section">
        <div className="section__head">
          <h2>Invoices</h2>
          <span className="rule" />
        </div>
        {invoices.length === 0 ? (
          <EmptyState title="No invoices yet" body="Once you spend on workloads, monthly invoices will appear here." />
        ) : (
          <table className="t-table">
            <thead>
              <tr>
                <th>Issued</th>
                <th>Due</th>
                <th>State</th>
                <th className="num">Total</th>
                <th>Paid</th>
              </tr>
            </thead>
            <tbody>
              {invoices.map((inv) => (
                <tr key={inv.id}>
                  <td className="nowrap">{formatRelative(inv.issued_at)}</td>
                  <td className="nowrap">{inv.due_at ? formatRelative(inv.due_at) : "—"}</td>
                  <td>
                    <StatusPill tone={inv.state === "paid" ? "ok" : inv.state === "overdue" ? "danger" : "quiet"}>
                      {inv.state}
                    </StatusPill>
                  </td>
                  <td className="num">{formatUsd(inv.total_cents)}</td>
                  <td className="nowrap">{inv.paid_at ? formatRelative(inv.paid_at) : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <Modal
        open={depositing}
        title="Top up wallet"
        body="Funds will be available immediately. For production deployments, real payment processing is configured by your account team."
        onClose={() => setDepositing(false)}
        actions={
          <>
            <button type="button" className="btn btn--quiet" onClick={() => setDepositing(false)}>Cancel</button>
            <button type="button" className="btn btn--primary" disabled={submitting} onClick={() => void deposit()}>
              {submitting ? "Submitting…" : `Add ${formatUsd(depositAmount * 100)}`}
            </button>
          </>
        }
      >
        <div className="field">
          <label htmlFor="amt">Amount (USD)</label>
          <input
            id="amt"
            type="number"
            min={1}
            value={depositAmount}
            onChange={(e) => setDepositAmount(Math.max(1, Number(e.target.value)))}
          />
          <span className="field-hint">Dev / staging backends mint instantly.</span>
        </div>
      </Modal>
    </main>
  );
}
