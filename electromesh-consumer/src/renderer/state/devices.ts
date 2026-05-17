import { create } from "zustand";
import { bridge } from "../api/bridge";

export interface DeviceSummary {
  id: string;
  label: string | null;
  device_class: string;
  status: string;
  trust_score?: number;
  last_seen_at?: string | null;
  earnings_cents_30d?: number;
  workunits_24h?: number;
  capabilities?: Record<string, unknown>;
  [k: string]: unknown;
}

interface DevicesState {
  list: DeviceSummary[];
  loading: boolean;
  error: string | null;
  currentId: string | null;
  refresh: () => Promise<void>;
  setCurrent: (id: string | null) => Promise<void>;
  register: (payload: {
    label?: string;
    device_class: string;
    capabilities?: Record<string, unknown>;
    consents?: Record<string, unknown>;
  }) => Promise<DeviceSummary>;
  decommission: (id: string) => Promise<void>;
}

export const useDevices = create<DevicesState>((set, get) => ({
  list: [],
  loading: false,
  error: null,
  currentId: null,
  async refresh() {
    set({ loading: true, error: null });
    try {
      const raw = await bridge.devices.list();
      const list: DeviceSummary[] = Array.isArray(raw)
        ? (raw as DeviceSummary[])
        : Array.isArray((raw as { items?: DeviceSummary[] })?.items)
          ? ((raw as { items: DeviceSummary[] }).items)
          : [];
      const currentId = await bridge.devices.current().catch(() => null);
      set({ list, currentId, loading: false });
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err), loading: false });
    }
  },
  async setCurrent(id) {
    await bridge.devices.setCurrent(id);
    set({ currentId: id });
  },
  async register(payload) {
    const dev = await bridge.devices.register(payload);
    await get().refresh();
    if (dev?.id) await get().setCurrent(dev.id);
    return dev as DeviceSummary;
  },
  async decommission(id) {
    await bridge.devices.decommission(id);
    await get().refresh();
  }
}));
