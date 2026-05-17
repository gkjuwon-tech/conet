/**
 * IPC channel names and shared constants for the consumer app.
 *
 * Every string here is both registered on the main side via
 * `ipcMain.handle` and exposed on the renderer side via the preload's
 * `contextBridge.exposeInMainWorld("electromesh", ...)`. Keep this file
 * the single source of truth for those names.
 */

export const IPC = {
  // config / preferences
  configGet: "config:get",
  configSet: "config:set",

  // auth (consumer = user JWT)
  authState: "auth:state",
  authLogin: "auth:login",
  authRegister: "auth:register",
  authLogout: "auth:logout",
  authOauth: "auth:oauth",
  authLoggedOut: "auth:logged-out",

  // generic backend pass-through
  apiCall: "api:call",

  // devices
  deviceList: "device:list",
  deviceRegister: "device:register",
  deviceDecommission: "device:decommission",
  deviceBenchmark: "device:benchmark",
  deviceCurrent: "device:current",
  deviceSetCurrent: "device:setCurrent",

  // agent
  agentStatus: "agent:status",
  agentStart: "agent:start",
  agentStop: "agent:stop",
  agentEvent: "agent:event",

  // misc
  systemInfo: "system:info",
  earningsHistory: "earnings:history",
  payoutRequest: "payout:request",
  dashboardFetch: "dashboard:fetch",

  // LAN / claim
  lanScan: "lan:scan",
  lanScanProgress: "lan:scan:progress",
  lanClaimRequest: "lan:claim:request",
  lanClaimVerify: "lan:claim:verify",
  lanClaimList: "lan:claim:list",
  lanPairAll: "lan:pair-all",
  lanPairProgress: "lan:pair:progress",
  lanOwnershipStartPin: "lan:ownership:start-pin",
  lanOwnershipVerifyPin: "lan:ownership:verify-pin",
  lanOwnershipVerifyMac: "lan:ownership:verify-mac",

  // phone-agent (passive bridge)
  phoneAgentStatus: "phone-agent:status",
  phoneAgentActivations: "phone-agent:activations",

  // android pairing
  androidStatus: "android:status",
  androidDiscover: "android:discover",
  androidDiscoverResults: "android:discover:results",
  androidEnroll: "android:enroll",
  androidEnrollMany: "android:enroll-many",
  androidFriendAdd: "android:friend:add",
  androidFriendVeto: "android:friend:veto",

  // benchmark progress
  benchmarkProgress: "benchmark:progress"
} as const;

export const DEFAULT_API_BASE = process.env.EM_API_BASE ?? "http://localhost:8080";

export const HEARTBEAT_INTERVAL_MS = 15_000;
export const WORK_POLL_INTERVAL_MS = 4_000;
export const BENCH_INTERVAL_MS = 12 * 60 * 60 * 1000; // 12h
export const RECONNECT_BASE_MS = 1500;
export const RECONNECT_MAX_MS = 30_000;

export const TOS_VERSION = "2025-01-01";
