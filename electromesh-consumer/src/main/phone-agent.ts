/**
 * Phone-agent bridge — paired phones run a tiny PWA that posts hash bursts
 * to the consumer Electron app via a localhost HTTP server. In this slim
 * rebuild we just expose the *status* IPC surface the renderer expects;
 * the actual local HTTP listener can be added later without touching the
 * renderer.
 */

export interface PhoneAgentStatus {
  running: boolean;
  port: number | null;
  pairedDevices: number;
  lastActivityAt: number | null;
}

const status: PhoneAgentStatus = {
  running: false,
  port: null,
  pairedDevices: 0,
  lastActivityAt: null
};

export function getStatus(): PhoneAgentStatus {
  return { ...status };
}

export interface PhoneActivation {
  device_id: string;
  ip: string;
  last_seen_at: number;
  workunits: number;
}

export function getActivations(): PhoneActivation[] {
  return [];
}
