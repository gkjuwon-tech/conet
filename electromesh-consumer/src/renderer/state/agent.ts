import { create } from "zustand";
import { bridge } from "../api/bridge";
import type { AgentStatus, DeviceSummary } from "../api/bridge";

interface AgentState {
  status: AgentStatus;
  devices: DeviceSummary[];
  refreshAll: () => Promise<void>;
  refreshStatus: () => Promise<void>;
  start: (deviceId?: string) => Promise<string | null>;
  stop: () => Promise<void>;
  setCurrent: (deviceId: string | null) => Promise<void>;
}

const empty: AgentStatus = {
  running: false,
  deviceId: null,
  attested: false,
  inflight: 0,
  capacity: 0,
  lastHeartbeatAt: null,
  lastClaimAt: null,
  lastError: null,
  units: []
};

export const useAgent = create<AgentState>((set) => ({
  status: empty,
  devices: [],
  refreshAll: async () => {
    const [status, list] = await Promise.all([
      bridge.agent.status(),
      bridge.devices.list()
    ]);
      set({
        status: status as AgentStatus,
        devices: list.ok && Array.isArray(list.items) ? (list.items as DeviceSummary[]) : []
      });
  },
  refreshStatus: async () => {
    const status = await bridge.agent.status();
    set({ status: status as AgentStatus });
  },
  start: async (deviceId?: string) => {
    const res = await bridge.agent.start(deviceId);
    if (res.ok) {
      set({ status: res.status as AgentStatus });
      return null;
    }
    return res.error ?? "failed to start";
  },
  stop: async () => {
    const res = await bridge.agent.stop();
    set({ status: res.status as AgentStatus });
  },
  setCurrent: async (deviceId) => {
    await bridge.devices.setCurrent(deviceId);
  }
}));

export function attachAgentEvents(): () => void {
  return bridge.agent.onEvent((payload: { type: string; status?: unknown }) => {
    if (payload.type === "status" && payload.status) {
      useAgent.setState({ status: payload.status as AgentStatus });
    }
  });
}
