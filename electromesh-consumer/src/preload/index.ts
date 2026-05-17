import { contextBridge, ipcRenderer } from "electron";

const IPC = {
  authState: "auth:state",
  authLogin: "auth:login",
  authRegister: "auth:register",
  authLogout: "auth:logout",
  authOauth: "auth:oauth",
  apiCall: "api:call",
  deviceList: "device:list",
  deviceRegister: "device:register",
  deviceDecommission: "device:decommission",
  deviceBenchmark: "device:benchmark",
  deviceCurrent: "device:current",
  deviceSetCurrent: "device:setCurrent",
  agentStatus: "agent:status",
  agentStart: "agent:start",
  agentStop: "agent:stop",
  agentEvent: "agent:event",
  systemInfo: "system:info",
  config: "config:get",
  configSet: "config:set",
  earningsHistory: "earnings:history",
  payoutRequest: "payout:request",
  lanScan: "lan:scan",
  lanScanProgress: "lan:scan:progress",
  lanClaimRequest: "lan:claim:request",
  lanClaimVerify: "lan:claim:verify",
  lanClaimList: "lan:claim:list",
  lanPairAll: "lan:pair-all",
  lanPairProgress: "lan:pair:progress",
  phoneAgentStatus: "phone-agent:status",
  phoneAgentActivations: "phone-agent:activations",
  androidStatus: "android:status",
  androidDiscover: "android:discover",
  androidDiscoverResults: "android:discover:results",
  androidEnroll: "android:enroll",
  androidEnrollMany: "android:enroll-many",
  androidAddFriend: "android:friend:add",
  androidVetoIp: "android:friend:veto",
  authLoggedOut: "auth:logged-out"
} as const;

const api = {
  config: {
    get: () => ipcRenderer.invoke(IPC.config),
    set: (payload: { apiBase?: string; preferences?: Record<string, unknown> }) =>
      ipcRenderer.invoke(IPC.configSet, payload)
  },
  auth: {
    state: () => ipcRenderer.invoke(IPC.authState),
    login: (payload: { email: string; password: string }) =>
      ipcRenderer.invoke(IPC.authLogin, payload),
    register: (payload: {
      email: string;
      password: string;
      display_name?: string;
      country_code?: string;
      accepted_tos_version: string;
    }) => ipcRenderer.invoke(IPC.authRegister, payload),
    logout: () => ipcRenderer.invoke(IPC.authLogout),
    oauth: (provider: "google" | "apple") =>
      ipcRenderer.invoke(IPC.authOauth, provider) as Promise<{
        ok: boolean;
        error?: string;
        user?: { id: string; email: string; display_name?: string };
      }>,
    onLoggedOut: (
      cb: (payload: { reason: string; error?: string }) => void
    ): (() => void) => {
      const listener = (
        _e: unknown,
        payload: { reason: string; error?: string }
      ) => cb(payload);
      ipcRenderer.on(IPC.authLoggedOut, listener);
      return () => {
        ipcRenderer.off(IPC.authLoggedOut, listener);
      };
    }
  },
  devices: {
    list: () => ipcRenderer.invoke(IPC.deviceList),
    register: (payload: {
      label?: string;
      device_class: string;
      consents?: Record<string, unknown>;
      capabilities?: Record<string, unknown>;
    }) => ipcRenderer.invoke(IPC.deviceRegister, payload),
    decommission: (id: string) => ipcRenderer.invoke(IPC.deviceDecommission, id),
    benchmark: (id: string) => ipcRenderer.invoke(IPC.deviceBenchmark, id),
    current: () => ipcRenderer.invoke(IPC.deviceCurrent),
    setCurrent: (id: string | null) => ipcRenderer.invoke(IPC.deviceSetCurrent, id)
  },
  agent: {
    status: () => ipcRenderer.invoke(IPC.agentStatus),
    start: (deviceId?: string) => ipcRenderer.invoke(IPC.agentStart, deviceId),
    stop: () => ipcRenderer.invoke(IPC.agentStop),
    onEvent: (cb: (payload: { type: string; status?: unknown }) => void) => {
      const listener = (_e: unknown, payload: { type: string; status?: unknown }) => cb(payload);
      ipcRenderer.on(IPC.agentEvent, listener);
      return () => ipcRenderer.off(IPC.agentEvent, listener);
    }
  },
  benchmark: {
    onProgress: (
      cb: (p: { phase: string; pct: number; detail?: string }) => void
    ) => {
      const listener = (
        _e: unknown,
        p: { phase: string; pct: number; detail?: string }
      ) => cb(p);
      ipcRenderer.on("benchmark:progress", listener);
      return () => ipcRenderer.off("benchmark:progress", listener);
    }
  },
  system: {
    snapshot: () => ipcRenderer.invoke(IPC.systemInfo)
  },
  payouts: {
    request: () => ipcRenderer.invoke(IPC.payoutRequest)
  },
  dashboard: {
    fetch: () => ipcRenderer.invoke(IPC.earningsHistory)
  },
  apiCall: (opts: { method?: string; path: string; body?: unknown }) =>
    ipcRenderer.invoke(IPC.apiCall, opts),

  lan: {
    scan: () => ipcRenderer.invoke(IPC.lanScan),
    onScanProgress: (cb: (event: unknown) => void) => {
      const listener = (_e: unknown, p: unknown) => cb(p);
      ipcRenderer.on(IPC.lanScanProgress, listener);
      return () => ipcRenderer.off(IPC.lanScanProgress, listener);
    },
    claimRequest: (payload: {
      lan_fingerprint: string;
      label?: string;
      gateway_mac?: string;
      advertised_subnet?: string;
    }) => ipcRenderer.invoke(IPC.lanClaimRequest, payload),
    claimVerify: (payload: { lan_fingerprint: string; otp: string }) =>
      ipcRenderer.invoke(IPC.lanClaimVerify, payload),
    claimList: () => ipcRenderer.invoke(IPC.lanClaimList),
    pairAll: (opts: {
      devices: Array<{
        ip: string;
        mac: string;
        hostname: string | null;
        vendor: string;
        device_class: string;
        label: string;
        randomized_mac: boolean;
        lan_fingerprint: string;
      }>;
      lanFingerprint: string;
      skipRandomized?: boolean;
      skipRouter?: boolean;
    }) => ipcRenderer.invoke(IPC.lanPairAll, opts),
    onPairProgress: (cb: (event: unknown) => void) => {
      const listener = (_e: unknown, p: unknown) => cb(p);
      ipcRenderer.on(IPC.lanPairProgress, listener);
      return () => ipcRenderer.off(IPC.lanPairProgress, listener);
    }
  },
  phoneAgent: {
    status: () => ipcRenderer.invoke(IPC.phoneAgentStatus),
    activations: () => ipcRenderer.invoke(IPC.phoneAgentActivations)
  },
  android: {
    status: () => ipcRenderer.invoke(IPC.androidStatus),
    discover: (opts?: { window_seconds?: number }) =>
      ipcRenderer.invoke(IPC.androidDiscover, opts ?? {}),
    discoverResults: () => ipcRenderer.invoke(IPC.androidDiscoverResults),
    enroll: (payload: {
      ip: string;
      port: number;
      pairing_kind: "tls_pair" | "tls_connect" | "legacy_connect";
      pin?: string | null;
      label?: string | null;
    }) => ipcRenderer.invoke(IPC.androidEnroll, payload),
    enrollMany: (payload: {
      offers: Array<{
        ip: string;
        port: number;
        pairing_kind: "tls_pair" | "tls_connect" | "legacy_connect";
        pin?: string | null;
        label?: string | null;
      }>;
    }) => ipcRenderer.invoke(IPC.androidEnrollMany, payload),
    addFriend: (payload: { ip?: string; mac?: string; label?: string }) =>
      ipcRenderer.invoke(IPC.androidAddFriend, payload),
    vetoIp: (ip: string) => ipcRenderer.invoke(IPC.androidVetoIp, ip)
  }
};

contextBridge.exposeInMainWorld("electromesh", api);

export type ElectroMeshApi = typeof api;
