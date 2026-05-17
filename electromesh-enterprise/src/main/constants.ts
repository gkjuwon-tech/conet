export const DEFAULT_API_BASE = process.env.EM_API_BASE ?? "http://localhost:8080";

export const STORAGE_FILE = "electromesh-enterprise.json";

export const IPC = {
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
