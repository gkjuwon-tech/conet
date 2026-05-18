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
import {
  scan as lanScan,
  claimRequest,
  claimVerify,
  claimList,
  pairAll,
  lanEvents,
  acceptClaimTos,
  autoClaimLocalLan
} from "./lan-scan";
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

async function handleApiError(err: unknown, opts: { expiresSession: boolean }): Promise<string> {
  // A 401 means "session is dead" only for endpoints that need to be
  // authenticated in the first place. For login/register/oauth the user has
  // no session yet — a 401 is just "those credentials are wrong" and must
  // surface in the form, not nuke the not-yet-authenticated state.
  if (opts.expiresSession && err instanceof HttpError && err.status === 401) {
    try { await agent.stop(); } catch { /* already stopped */ }
    persistence.clearAuth();
    sendIfAlive(IPC.authLoggedOut, { reason: "unauthorized" });
  }
  if (err instanceof HttpError && err.status === 401 && !opts.expiresSession) {
    // Backend message for failed login is often a curt `HTTP 401`. Rewrite
    // it to something the end user can act on.
    if (!err.message || /^HTTP\s+401$/i.test(err.message)) {
      return "Email or password is incorrect.";
    }
  }
  if (err instanceof HttpError) return err.message;
  if (err instanceof Error) return err.message;
  return String(err);
}

interface GuardOpts {
  /** If false, a backend 401 from this handler will NOT clear the session
   *  or broadcast `auth:logged-out`. Set to false on the login / register /
   *  oauth handlers — those endpoints don't run against an existing session.
   *  Defaults to true. */
  expiresSession?: boolean;
}

function guard<TArgs extends unknown[], TOut>(
  channel: string,
  fn: (event: IpcMainInvokeEvent, ...args: TArgs) => Promise<TOut>,
  opts: GuardOpts = {}
) {
  const expiresSession = opts.expiresSession ?? true;
  ipcMain.handle(channel, async (event, ...args) => {
    try {
      const data = await fn(event, ...(args as TArgs));
      return { ok: true, data } as Result<TOut>;
    } catch (err) {
      const message = await handleApiError(err, { expiresSession });
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
  }, { expiresSession: false });
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
  }, { expiresSession: false });
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
  }, { expiresSession: false });

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
    lan_fingerprint?: string;
  }) => {
    // The backend requires a verified LAN claim before any device can be
    // registered. When the renderer calls register() without supplying a
    // fingerprint — that's the "Just this computer" / Pair-this-device
    // flow — we transparently run the claim chain for the local LAN here
    // so the user never has to detour through the LAN wizard just to add
    // their own machine.
    let body: Record<string, unknown> = { ...payload };
    if (!payload.lan_fingerprint) {
      const claimed = await autoClaimLocalLan();
      body = { ...body, lan_fingerprint: claimed.lan_fingerprint };
    }
    const dev = await api.registerDevice(body as Parameters<typeof api.registerDevice>[0]);
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
  guard(IPC.lanScan, async () => {
    // Auto-accept the LAN-claim ToS the first time the user runs a sweep
    // so the renderer never sees the leaky 403 "POST /v1/claim/tos/accept
    // first" message. Idempotent server-side.
    await acceptClaimTos();
    return lanScan();
  });
  guard(IPC.lanTosAccept, async () => acceptClaimTos());
  guard(IPC.lanClaimRequest, async (_e, payload: {
    lan_fingerprint: string; label?: string; gateway_mac?: string; advertised_subnet?: string;
  }) => claimRequest(payload));
  guard(IPC.lanClaimVerify, async (_e, payload: { lan_fingerprint: string; otp: string }) => claimVerify(payload));
  guard(IPC.lanClaimList, async () => claimList());
  guard(IPC.lanAutoClaimLocal, async () => autoClaimLocalLan());
  guard(IPC.lanPairAll, async (_e, payload: Parameters<typeof pairAll>[0]) => pairAll(payload));

  // ── Device ownership challenge ─────────────────────────────────────
  //
  // Thin passthrough to the new `/v1/devices/ownership/*` API. Every
  // payload shape mirrors the backend Pydantic schema so the renderer
  // never has to know what method the backend ultimately demanded.
  guard(IPC.ownershipChallenge, async (_e, payload: {
    device_ip: string;
    method: "pin_display" | "mac_serial" | "signed_attestation";
    device_mac?: string;
    expected_serial?: string;
    public_key_pem?: string;
  }) =>
    api.call({
      method: "POST",
      path: "/v1/devices/ownership/challenge",
      body: payload
    })
  );
  guard(IPC.ownershipRespond, async (_e, payload: {
    challenge_id: string;
    pin?: string;
    mac?: string;
    serial?: string;
    signature_hex?: string;
  }) =>
    api.call({
      method: "POST",
      path: "/v1/devices/ownership/respond",
      body: payload
    })
  );
  guard(IPC.ownershipStatus, async (_e, deviceIp: string) =>
    api.call({
      method: "GET",
      path: `/v1/devices/ownership/status?device_ip=${encodeURIComponent(deviceIp)}`
    })
  );
  guard(IPC.ownershipCancel, async (_e, challengeId: string) =>
    api.call({
      method: "DELETE",
      path: `/v1/devices/ownership/${encodeURIComponent(challengeId)}`
    })
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
