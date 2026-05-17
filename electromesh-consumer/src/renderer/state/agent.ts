import { create } from "zustand";
import { bridge } from "../api/bridge";

export interface AgentStatusSnapshot {
  running: boolean;
  deviceId: string | null;
  lastTickAt: number | null;
  lastHeartbeatAt: number | null;
  lastWorkAt: number | null;
  lastError: string | null;
  workunitsCompleted: number;
  workunitsActive: number;
}

interface AgentState {
  status: AgentStatusSnapshot;
  starting: boolean;
  stopping: boolean;
  error: string | null;
  refresh: () => Promise<void>;
  start: (deviceId?: string) => Promise<void>;
  stop: () => Promise<void>;
  subscribe: () => () => void;
}

const empty: AgentStatusSnapshot = {
  running: false,
  deviceId: null,
  lastTickAt: null,
  lastHeartbeatAt: null,
  lastWorkAt: null,
  lastError: null,
  workunitsCompleted: 0,
  workunitsActive: 0
};

export const useAgent = create<AgentState>((set, get) => ({
  status: empty,
  starting: false,
  stopping: false,
  error: null,
  async refresh() {
    try {
      const status = await bridge.agent.status();
      set({ status, error: null });
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err) });
    }
  },
  async start(deviceId) {
    set({ starting: true, error: null });
    try {
      await bridge.agent.start(deviceId);
      await get().refresh();
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err) });
      throw err;
    } finally {
      set({ starting: false });
    }
  },
  async stop() {
    set({ stopping: true, error: null });
    try {
      await bridge.agent.stop();
      await get().refresh();
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err) });
    } finally {
      set({ stopping: false });
    }
  },
  subscribe() {
    return bridge.agent.onEvent((payload) => {
      const p = payload as { status?: AgentStatusSnapshot };
      if (p && p.status) set({ status: p.status });
      else void get().refresh();
    });
  }
}));
