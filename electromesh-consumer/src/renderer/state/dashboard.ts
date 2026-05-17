import { create } from "zustand";
import { bridge } from "../api/bridge";
import type { DashboardSnapshot } from "../api/bridge";

interface DashState {
  snapshot: DashboardSnapshot | null;
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
}

export const useDashboard = create<DashState>((set) => ({
  snapshot: null,
  loading: false,
  error: null,
  refresh: async () => {
    set({ loading: true, error: null });
    const res = await bridge.dashboard.fetch();
    if (res.ok) {
      set({ snapshot: res.dashboard as DashboardSnapshot, loading: false });
    } else {
      set({ loading: false, error: res.error ?? "dashboard fetch failed" });
    }
  }
}));
