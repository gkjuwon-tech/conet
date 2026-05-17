import { create } from "zustand";
import { bridge } from "../api/bridge";

export interface DashboardSnapshot {
  wallet_balance_cents: number;
  total_earnings_cents: number;
  total_workunits_24h: number;
  total_workunits_30d: number;
  active_device_count: number;
  device_count: number;
  payout_pending_cents?: number;
  next_payout_at?: string | null;
  ledger?: Array<{
    id?: string;
    ts: string;
    kind: string;
    amount_cents: number;
    description?: string;
  }>;
  devices?: Array<{
    id: string;
    label: string | null;
    device_class: string;
    status: string;
    earnings_cents_24h?: number;
    workunits_24h?: number;
    trust_score?: number;
    last_seen_at?: string;
  }>;
}

interface DashboardState {
  snapshot: DashboardSnapshot | null;
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
}

export const useDashboard = create<DashboardState>((set) => ({
  snapshot: null,
  loading: false,
  error: null,
  async refresh() {
    set({ loading: true, error: null });
    try {
      const data = await bridge.dashboard.fetch();
      set({ snapshot: data as DashboardSnapshot, loading: false });
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err), loading: false });
    }
  }
}));
