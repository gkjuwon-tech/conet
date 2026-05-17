export const DEFAULT_API_BASE = process.env.EM_API_BASE ?? "http://localhost:8080";
export const DEFAULT_WS_BASE =
  process.env.EM_WS_BASE ?? DEFAULT_API_BASE.replace(/^http/, "ws");

export const HEARTBEAT_INTERVAL_MS = 15_000;
export const RECONNECT_BASE_MS = 1_500;
export const RECONNECT_MAX_MS = 30_000;
export const WORK_POLL_INTERVAL_MS = 4_000;
export const BENCH_INTERVAL_MS = 12 * 60 * 60 * 1000;

export const STORAGE_FILE = "electromesh-consumer.json";

export const IPC = {
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
  phoneAgentActivations: "phone-agent:activations"
} as const;

export type IpcChannel = (typeof IPC)[keyof typeof IPC];
