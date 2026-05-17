import { contextBridge, ipcRenderer } from "electron";

const IPC = {
  configGet: "config:get",
  configSet: "config:set",
  authState: "auth:state",
  authConnect: "auth:connect",
  authDisconnect: "auth:disconnect",
  apiCall: "api:call",
  marketplaceSearch: "marketplace:search",
  marketplaceQuote: "marketplace:quote",
  jobsList: "jobs:list",
  jobsGet: "jobs:get",
  jobsSubmit: "jobs:submit",
  jobsCancel: "jobs:cancel",
  jobsFinalize: "jobs:finalize",
  jobsWorkunits: "jobs:workunits",
  apiKeysList: "apiKeys:list",
  apiKeysCreate: "apiKeys:create",
  apiKeysRevoke: "apiKeys:revoke",
  stats: "stats:fetch"
} as const;

const api = {
  config: {
    get: () => ipcRenderer.invoke(IPC.configGet),
    set: (payload: { apiBase?: string }) =>
      ipcRenderer.invoke(IPC.configSet, payload)
  },
  auth: {
    state: () => ipcRenderer.invoke(IPC.authState),
    connect: (payload: { apiBase?: string; apiKey: string }) =>
      ipcRenderer.invoke(IPC.authConnect, payload),
    disconnect: () => ipcRenderer.invoke(IPC.authDisconnect)
  },
  stats: {
    fetch: () => ipcRenderer.invoke(IPC.stats)
  },
  marketplace: {
    search: (filt: Record<string, unknown>) =>
      ipcRenderer.invoke(IPC.marketplaceSearch, filt),
    quote: (payload: { cluster_ids: string[]; hours: number }) =>
      ipcRenderer.invoke(IPC.marketplaceQuote, payload)
  },
  jobs: {
    list: (limit?: number) => ipcRenderer.invoke(IPC.jobsList, limit),
    get: (id: string) => ipcRenderer.invoke(IPC.jobsGet, id),
    workunits: (id: string) => ipcRenderer.invoke(IPC.jobsWorkunits, id),
    submit: (payload: Record<string, unknown>) =>
      ipcRenderer.invoke(IPC.jobsSubmit, payload),
    cancel: (id: string, reason?: string) =>
      ipcRenderer.invoke(IPC.jobsCancel, { id, reason }),
    finalize: (id: string) => ipcRenderer.invoke(IPC.jobsFinalize, id)
  },
  apiKeys: {
    list: () => ipcRenderer.invoke(IPC.apiKeysList),
    create: (payload: { label: string; scopes: string[]; expires_in_days?: number }) =>
      ipcRenderer.invoke(IPC.apiKeysCreate, payload),
    revoke: (id: string) => ipcRenderer.invoke(IPC.apiKeysRevoke, id)
  },
  apiCall: (opts: { method?: string; path: string; body?: unknown }) =>
    ipcRenderer.invoke(IPC.apiCall, opts)
};

contextBridge.exposeInMainWorld("electromesh", api);

export type ElectroMeshEnterpriseApi = typeof api;
