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
    connect: (payload: { apiKey: string; apiBase?: string }) => invoke(IPC.authConnect, payload),
    disconnect: () => invoke(IPC.authDisconnect),
    onLoggedOut: (cb: (p: unknown) => void) => on(IPC.authLoggedOut, cb)
  },
  api: {
    call: <T = unknown>(opts: { method?: string; path: string; body?: unknown }) =>
      invoke<T>(IPC.apiCall, opts)
  },
  marketplace: {
    list: (filters?: Record<string, unknown>) => invoke(IPC.marketplaceList, filters),
    item: (id: string) => invoke(IPC.marketplaceItem, id)
  },
  jobs: {
    list: (filters?: Record<string, unknown>) => invoke(IPC.jobsList, filters),
    create: (payload: Record<string, unknown>) => invoke(IPC.jobsCreate, payload),
    cancel: (id: string) => invoke(IPC.jobsCancel, id),
    get: (id: string) => invoke(IPC.jobsGet, id),
    logs: (id: string) => invoke(IPC.jobsLogs, id),
    workunits: (id: string) => invoke(IPC.jobsWorkunits, id)
  },
  clusters: {
    list: () => invoke(IPC.clustersList),
    get: (id: string) => invoke(IPC.clustersGet, id),
    create: (payload: Record<string, unknown>) => invoke(IPC.clustersCreate, payload),
    delete: (id: string) => invoke(IPC.clustersDelete, id)
  },
  wallet: {
    balance: () => invoke(IPC.walletBalance),
    deposit: (payload: { amount_cents: number; method?: string }) => invoke(IPC.walletDeposit, payload),
    invoices: () => invoke(IPC.walletInvoices)
  },
  apiKeys: {
    list: () => invoke(IPC.apiKeysList),
    create: (payload: { label?: string; scopes?: string[]; expires_in_days?: number }) => invoke(IPC.apiKeysCreate, payload),
    revoke: (id: string, reason?: string) => invoke(IPC.apiKeysRevoke, id, reason)
  }
};

export type ElectromeshEnterpriseBridge = typeof bridge;

contextBridge.exposeInMainWorld("electromesh", bridge);
