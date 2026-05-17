import { create } from "zustand";
import type { ClusterCard } from "../api/bridge";

export interface CartLine {
  cluster: ClusterCard;
  hours: number;
}

interface CartState {
  lines: CartLine[];
  add: (cluster: ClusterCard, hours: number) => void;
  remove: (clusterId: string) => void;
  setHours: (clusterId: string, hours: number) => void;
  clear: () => void;
  totals: () => { usd: number; h100Hours: number };
}

export const useCart = create<CartState>((set, get) => ({
  lines: [],
  add: (cluster, hours) =>
    set((state) => {
      if (state.lines.some((l) => l.cluster.id === cluster.id)) return state;
      return { lines: [...state.lines, { cluster, hours }] };
    }),
  remove: (id) =>
    set((state) => ({ lines: state.lines.filter((l) => l.cluster.id !== id) })),
  setHours: (id, hours) =>
    set((state) => ({
      lines: state.lines.map((l) =>
        l.cluster.id === id ? { ...l, hours } : l
      )
    })),
  clear: () => set({ lines: [] }),
  totals: () => {
    const lines = get().lines;
    return {
      usd: lines.reduce((s, l) => s + l.cluster.price_usd_per_hour * l.hours, 0),
      h100Hours: lines.reduce((s, l) => s + l.cluster.h100_equivalent * l.hours, 0)
    };
  }
}));
