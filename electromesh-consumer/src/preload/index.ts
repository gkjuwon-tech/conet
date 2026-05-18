import { contextBridge, ipcRenderer, IpcRendererEvent } from "electron";
import { IPC } from "../main/constants";

type Result<T> = { ok: true; data?: T } | { ok: false; error: string };

function invoke<T = unknown>(channel: string, ...args: unknown[]): Promise<Result<T>> {
  return ipcRenderer.invoke(channel, ...args) as Promise<Result<T>>;
}

function on(channel: string, listener: (payload: unknown) => void) {
  const wrapped = (_e: IpcRendererEvent, payload: unknown) => listener(payload);
  ipcRenderer.on(channel, wrapped);
  return () => ipcRenderer.removeListener(channel, wrapped);
}

const bridge = {
  config: {
    get: () => invoke(IPC.configGet),
    set: (partial: Record<string, unknown>) => invoke(IPC.configSet, partial)
  },
  auth: {
    state: () => invoke(IPC.authState),
    login: (email: string, password: string) => invoke(IPC.authLogin, { email, password }),
    register: (payload: {
      email: string;
      password: string;
      display_name?: string;
      country_code?: string;
    }) => invoke(IPC.authRegister, payload),
    logout: () => invoke(IPC.authLogout),
    oauth: (provider: "google" | "apple") => invoke(IPC.authOauth, provider),
    onLoggedOut: (cb: (payload: unknown) => void) => on(IPC.authLoggedOut, cb)
  },
  api: {
    call: <T = unknown>(opts: { method?: string; path: string; body?: unknown }) =>
      invoke<T>(IPC.apiCall, opts)
  },
  devices: {
    list: () => invoke(IPC.deviceList),
    register: (payload: {
      label?: string;
      device_class: string;
      capabilities?: Record<string, unknown>;
      consents?: Record<string, unknown>;
    }) => invoke(IPC.deviceRegister, payload),
    decommission: (id: string) => invoke(IPC.deviceDecommission, id),
    benchmark: (id: string) => invoke(IPC.deviceBenchmark, id),
    current: () => invoke<string | null>(IPC.deviceCurrent),
    setCurrent: (id: string | null) => invoke(IPC.deviceSetCurrent, id),
    onBenchmarkProgress: (cb: (payload: unknown) => void) => on(IPC.benchmarkProgress, cb)
  },
  agent: {
    status: () => invoke(IPC.agentStatus),
    start: (deviceId?: string) => invoke(IPC.agentStart, deviceId),
    stop: () => invoke(IPC.agentStop),
    onEvent: (cb: (payload: unknown) => void) => on(IPC.agentEvent, cb)
  },
  system: {
    info: () => invoke(IPC.systemInfo)
  },
  dashboard: {
    fetch: () => invoke(IPC.dashboardFetch),
    earnings: () => invoke(IPC.earningsHistory),
    payoutRequest: () => invoke(IPC.payoutRequest)
  },
  lan: {
    scan: () => invoke(IPC.lanScan),
    acceptTos: () => invoke<void>(IPC.lanTosAccept),
    autoClaimLocal: () => invoke<{ lan_fingerprint: string }>(IPC.lanAutoClaimLocal),
    claimRequest: (payload: {
      lan_fingerprint: string;
      label?: string;
      gateway_mac?: string;
      advertised_subnet?: string;
    }) => invoke(IPC.lanClaimRequest, payload),
    claimVerify: (payload: { lan_fingerprint: string; otp: string }) =>
      invoke(IPC.lanClaimVerify, payload),
    claimList: () => invoke(IPC.lanClaimList),
    pairAll: (payload: {
      devices: unknown[];
      lanFingerprint: string;
      skipRandomized?: boolean;
      skipRouter?: boolean;
    }) => invoke(IPC.lanPairAll, payload),
    onScanProgress: (cb: (payload: unknown) => void) => on(IPC.lanScanProgress, cb),
    onPairProgress: (cb: (payload: unknown) => void) => on(IPC.lanPairProgress, cb)
  },
  ownership: {
    challenge: (payload: {
      device_ip: string;
      method: "pin_display" | "mac_serial" | "signed_attestation";
      device_mac?: string;
      expected_serial?: string;
      public_key_pem?: string;
    }) => invoke(IPC.ownershipChallenge, payload),
    respond: (payload: {
      challenge_id: string;
      pin?: string;
      mac?: string;
      serial?: string;
      signature_hex?: string;
    }) => invoke(IPC.ownershipRespond, payload),
    status: (deviceIp: string) => invoke(IPC.ownershipStatus, deviceIp),
    cancel: (challengeId: string) => invoke(IPC.ownershipCancel, challengeId)
  },
  phoneAgent: {
    status: () => invoke(IPC.phoneAgentStatus),
    activations: () => invoke(IPC.phoneAgentActivations)
  },
  android: {
    status: () => invoke(IPC.androidStatus),
    discover: (opts?: { window_seconds?: number }) => invoke(IPC.androidDiscover, opts),
    results: () => invoke(IPC.androidDiscoverResults),
    enroll: (payload: Record<string, unknown>) => invoke(IPC.androidEnroll, payload),
    enrollMany: (payload: Record<string, unknown>) => invoke(IPC.androidEnrollMany, payload),
    addFriend: (payload: Record<string, unknown>) => invoke(IPC.androidFriendAdd, payload),
    vetoIp: (ip: string) => invoke(IPC.androidFriendVeto, ip)
  },
  navigation: {
    onGoto: (cb: (route: string) => void) =>
      on("nav:goto", (payload) => cb(String(payload)))
  }
};

export type ElectromeshBridge = typeof bridge;

contextBridge.exposeInMainWorld("electromesh", bridge);
