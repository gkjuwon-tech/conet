/**
 * IPC handler registration. Every handler is wrapped in `guard()` so that
 * (a) errors are returned as `{ ok: false, error }` instead of thrown over
 *     the IPC bus (the renderer pattern matches on `ok`), and
 * (b) HTTP 401 from the backend triggers `clearAuth()` + a `auth:logged-out`
 *     broadcast so the renderer flushes its state and shows the login page.
 */

import { app, BrowserWindow, ipcMain, IpcMainInvokeEvent } from "electron";
import { IPC, TOS_VERSION } from "./constants";
import { api, HttpError } from "./api-client";
import { persistence } from "./store";
import { agent } from "./agent";
import { snapshot } from "./system-info";
import { runBenchmark, benchmarkEvents } from "./benchmark";
import { oauthLogin } from "./oauth";
import { scan as lanScan, claimRequest, claimVerify, claimList, pairAll, lanEvents } from "./lan-scan";
import { getStatus as phoneAgentStatus, getActivations as phoneAgentActivations } from "./phone-agent";

type Result<T> = { ok: true; data?: T } | { ok: false; error: string };

let windowRef: BrowserWindow | null = null;
export function setIpcWindow(win: BrowserWindow) {
  windowRef = win;
  // forward agent + lan + benchmark events to renderer.
  agent.on("event", (payload) => sendIfAlive(IPC.agentEvent, payload));
  agent.on("error", () => sendIfAlive(IPC.authLoggedOut, { reason: "unauthorized" }));
  lanEvents.on("scan:progress", (p) => sendIfAlive(IPC.lanScanProgress, p));
  lanEvents.on("pair:progress", (p) => sendIfAlive(IPC.lanPairProgress, p));
  benchmarkEvents.on("progress", (p) => sendIfAlive(IPC.benchmarkProgress, p));
}

function sendIfAlive(channel: string, payload: unknown) {
  if (!windowRef || windowRef.isDestroyed()) return;
  try {
    windowRef.webContents.send(channel, payload);
  } catch {
    /* renderer is gone */
  }
}

async function handleApiError(err: unknown): Promise<string> {
  if (err instanceof HttpError && err.status === 401) {
    try { await agent.stop(); } catch { /* already stopped */ }
    persistence.clearAuth();
    sendIfAlive(IPC.authLoggedOut, { reason: "unauthorized" });
  }
  if (err instanceof HttpError) return err.message;
  if (err instanceof Error) return err.message;
  return String(err);
}

function guard<TArgs extends unknown[], TOut>(
  channel: string,
  fn: (event: IpcMainInvokeEvent, ...args: TArgs) => Promise<TOut>
) {
  ipcMain.handle(channel, async (event, ...args) => {
    try {
      const data = await fn(event, ...(args as TArgs));
      return { ok: true, data } as Result<TOut>;
    } catch (err) {
      const message = await handleApiError(err);
      return { ok: false, error: message } as Result<TOut>;
    }
  });
}

export function registerHandlers() {
  // ── config ─────────────────────────────────────────────────────────
  guard(IPC.configGet, async () => persistence.snapshot());
  guard(IPC.configSet, async (_e, partial: Partial<{ apiBase: string; preferences: Record<string, unknown> }>) => {
    if (partial.apiBase) persistence.setApiBase(partial.apiBase);
    if (partial.preferences) persistence.patchPreferences(partial.preferences);
    return persistence.snapshot();
  });

  // ── auth ───────────────────────────────────────────────────────────
  guard(IPC.authState, async () => {
    if (!persistence.userToken) return { authenticated: false as const };
    try {
      const me = await api.me();
      return { authenticated: true as const, user: me };
    } catch (err) {
      if (err instanceof HttpError && err.status === 401) {
        persistence.clearAuth();
        return { authenticated: false as const };
      }
      throw err;
    }
  });
  guard(IPC.authLogin, async (_e, payload: { email: string; password: string }) => {
    const tokens = await api.login(payload);
    persistence.setTokens({ access_token: tokens.access_token, refresh_token: tokens.refresh_token });
    const me = await api.me();
    return { user: me };
  });
  guard(IPC.authRegister, async (_e, payload: {
    email: string;
    password: string;
    display_name?: string;
    country_code?: string;
  }) => {
    await api.register({ ...payload, accepted_tos_version: TOS_VERSION });
    const tokens = await api.login({ email: payload.email, password: payload.password });
    persistence.setTokens({ access_token: tokens.access_token, refresh_token: tokens.refresh_token });
    const me = await api.me();
    return { user: me };
  });
  guard(IPC.authLogout, async () => {
    try { await agent.stop(); } catch { /* ignore */ }
    persistence.clearAuth();
    return { ok: true };
  });
  guard(IPC.authOauth, async (_e, provider: "google" | "apple") => {
    const res = await oauthLogin(provider);
    if (!res.ok) throw new Error(res.error);
    const me = await api.me();
    return { user: me };
  });

  // ── generic passthrough (useful for renderer-side calls we haven't typed) ─
  guard(IPC.apiCall, async (_e, opts: { method?: string; path: string; body?: unknown }) => {
    return api.call({ method: opts.method, path: opts.path, body: opts.body });
  });

  // ── devices ────────────────────────────────────────────────────────
  guard(IPC.deviceList, async () => api.listDevices());
  guard(IPC.deviceRegister, async (_e, payload: {
    label?: string;
    device_class: string;
    capabilities?: Record<string, unknown>;
    consents?: Record<string, unknown>;
  }) => {
    const dev = await api.registerDevice(payload);
    if (dev && typeof dev === "object" && "id" in dev) {
      persistence.setCurrentDeviceId(String((dev as { id: unknown }).id));
    }
    return dev;
  });
  guard(IPC.deviceDecommission, async (_e, id: string) => api.decommissionDevice(id));
  guard(IPC.deviceBenchmark, async (_e, id: string) => {
    const result = await runBenchmark();
    await api.postBenchmark(id, {
      hashrate_mhs: result.hashrate_mhs,
      ram_mb: result.ram_mb,
      power_w: result.power_w
    });
    return result;
  });
  guard(IPC.deviceCurrent, async () => persistence.currentDeviceId);
  guard(IPC.deviceSetCurrent, async (_e, id: string | null) => {
    persistence.setCurrentDeviceId(id);
    return persistence.currentDeviceId;
  });

  // ── agent ──────────────────────────────────────────────────────────
  guard(IPC.agentStatus, async () => agent.getStatus());
  guard(IPC.agentStart, async (_e, deviceId?: string) => {
    await agent.start(deviceId);
    return agent.getStatus();
  });
  guard(IPC.agentStop, async () => {
    await agent.stop();
    return agent.getStatus();
  });

  // ── misc ───────────────────────────────────────────────────────────
  guard(IPC.systemInfo, async () => snapshot());
  guard(IPC.earningsHistory, async () => api.earnings());
  guard(IPC.payoutRequest, async () => api.payoutRequest());
  guard(IPC.dashboardFetch, async () => api.dashboard());

  // ── LAN / claim ────────────────────────────────────────────────────
  guard(IPC.lanScan, async () => lanScan());
  guard(IPC.lanClaimRequest, async (_e, payload: {
    lan_fingerprint: string; label?: string; gateway_mac?: string; advertised_subnet?: string;
  }) => claimRequest(payload));
  guard(IPC.lanClaimVerify, async (_e, payload: { lan_fingerprint: string; otp: string }) => claimVerify(payload));
  guard(IPC.lanClaimList, async () => claimList());
  guard(IPC.lanPairAll, async (_e, payload: Parameters<typeof pairAll>[0]) => pairAll(payload));

  // ── Ownership verification ─────────────────────────────────────────────
  guard(IPC.lanOwnershipStartPin, async (_e, device_ip: string) =>
    api.call({ method: "POST", path: "/v1/claim/ownership/start-pin", body: { device_ip } })
  );
  guard(IPC.lanOwnershipVerifyPin, async (_e, device_ip: string, pin: string) =>
    api.call({ method: "POST", path: "/v1/claim/ownership/verify-pin", body: { device_ip, pin } })
  );
  guard(IPC.lanOwnershipVerifyMac, async (_e, device_ip: string, mac: string, serial?: string) =>
    api.call({ method: "POST", path: "/v1/claim/ownership/verify-mac", body: { device_ip, mac, serial } })
  );

  // ── phone-agent ────────────────────────────────────────────────────
  guard(IPC.phoneAgentStatus, async () => phoneAgentStatus());
  guard(IPC.phoneAgentActivations, async () => phoneAgentActivations());

  // ── android ────────────────────────────────────────────────────────
  guard(IPC.androidStatus, async () => api.androidStatus());
  guard(IPC.androidDiscover, async (_e, opts?: { window_seconds?: number }) => api.androidDiscover(opts ?? {}));
  guard(IPC.androidDiscoverResults, async () => api.androidDiscoverResults());
  guard(IPC.androidEnroll, async (_e, payload: Record<string, unknown>) => api.androidEnroll(payload));
  guard(IPC.androidEnrollMany, async (_e, payload: Record<string, unknown>) => api.androidEnrollMany(payload));
  guard(IPC.androidFriendAdd, async (_e, payload: Record<string, unknown>) => api.androidAddFriend(payload));
  guard(IPC.androidFriendVeto, async (_e, ip: string) => api.androidVetoIp(ip));

  app.on("before-quit", () => {
    void agent.stop();
  });
}
