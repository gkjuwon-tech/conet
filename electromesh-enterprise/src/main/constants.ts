/**
 * Enterprise IPC channel constants. Stays in lock-step with the
 * preload's `contextBridge` surface.
 */

export const IPC = {
  configGet: "config:get",
  configSet: "config:set",

  apiCall: "api:call",

  authState: "auth:state",
  authConnect: "auth:connect",
  authDisconnect: "auth:disconnect",
  authLoggedOut: "auth:logged-out",

  marketplaceList: "marketplace:list",
  marketplaceItem: "marketplace:item",

  jobsList: "jobs:list",
  jobsCreate: "jobs:create",
  jobsCancel: "jobs:cancel",
  jobsGet: "jobs:get",
  jobsLogs: "jobs:logs",
  jobsWorkunits: "jobs:workunits",

  clustersList: "clusters:list",
  clustersCreate: "clusters:create",
  clustersDelete: "clusters:delete",

  walletBalance: "wallet:balance",
  walletDeposit: "wallet:deposit",
  walletInvoices: "wallet:invoices",

  apiKeysList: "apiKeys:list",
  apiKeysCreate: "apiKeys:create",
  apiKeysRevoke: "apiKeys:revoke"
} as const;

export const DEFAULT_API_BASE = process.env.EM_API_BASE ?? "http://localhost:8080";
