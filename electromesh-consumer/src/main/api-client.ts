/**
 * Thin HTTP client wrapping Electron's net module for talking to the
 * conet FastAPI backend. Methods return the parsed JSON body or throw an
 * `HttpError` carrying status + parsed error payload.
 *
 * Auth: a single bearer token (the user JWT) is attached to every call.
 * Device-token requests (`/v1/agent/*`) use a per-device token instead;
 * callers pass it explicitly.
 */

import { net } from "electron";
import { persistence } from "./store";

export class HttpError extends Error {
  status: number;
  body: unknown;
  constructor(status: number, body: unknown, message?: string) {
    super(message ?? `HTTP ${status}`);
    this.name = "HttpError";
    this.status = status;
    this.body = body;
  }
}

function describeDetail(detail: unknown): string {
  if (detail == null) return "";
  if (typeof detail === "string") return detail;
  if (Array.isArray(detail)) {
    const parts: string[] = [];
    for (const entry of detail) {
      if (entry && typeof entry === "object") {
        const e = entry as { msg?: unknown; loc?: unknown; type?: unknown };
        const msg = typeof e.msg === "string" ? e.msg : "";
        const loc = Array.isArray(e.loc) ? (e.loc as unknown[]).join(".") : "";
        if (msg && loc) parts.push(`${loc}: ${msg}`);
        else if (msg) parts.push(msg);
        else {
          try { parts.push(JSON.stringify(entry)); } catch { parts.push(String(entry)); }
        }
      } else {
        parts.push(String(entry));
      }
    }
    return parts.join("; ");
  }
  if (typeof detail === "object") {
    const d = detail as Record<string, unknown>;
    if (typeof d.msg === "string") return d.msg;
    if (typeof d.message === "string") return d.message;
    try { return JSON.stringify(detail); } catch { return "Unknown error"; }
  }
  return String(detail);
}

function describeHttpError(status: number, parsed: unknown): string {
  if (parsed && typeof parsed === "object") {
    const body = parsed as Record<string, unknown>;
    if ("detail" in body) {
      const msg = describeDetail(body.detail);
      if (msg) return msg;
    }
    if (typeof body.message === "string") return body.message;
    if (typeof body.error === "string") return body.error;
  }
  if (typeof parsed === "string" && parsed.trim()) return parsed.trim();
  return `HTTP ${status}`;
}

interface CallOpts {
  method?: string;
  path: string;
  body?: unknown;
  token?: string | null;       // override the default user token
  noAuth?: boolean;            // for login/register endpoints
  headers?: Record<string, string>;
  timeoutMs?: number;
}

function joinUrl(base: string, path: string): string {
  if (path.startsWith("http://") || path.startsWith("https://")) return path;
  return `${base.replace(/\/$/, "")}/${path.replace(/^\//, "")}`;
}

export class ApiClient {
  async call<T>(opts: CallOpts): Promise<T> {
    const base = persistence.apiBase;
    const url = joinUrl(base, opts.path);
    const method = opts.method ?? "GET";
    const token = opts.noAuth ? null : (opts.token ?? persistence.userToken);
    const bodyBuffer = opts.body !== undefined ? Buffer.from(JSON.stringify(opts.body)) : undefined;

    return new Promise<T>((resolve, reject) => {
      const request = net.request({ method, url });
      const headers: Record<string, string> = {
        Accept: "application/json",
        ...(opts.headers ?? {})
      };
      if (bodyBuffer) headers["Content-Type"] = "application/json";
      if (token) headers.Authorization = `Bearer ${token}`;
      for (const [k, v] of Object.entries(headers)) request.setHeader(k, v);

      const chunks: Buffer[] = [];
      let status = 0;

      const timeout = setTimeout(() => {
        try { request.abort(); } catch { /* ignore */ }
        reject(new Error(`Timeout after ${opts.timeoutMs ?? 30_000}ms calling ${method} ${opts.path}`));
      }, opts.timeoutMs ?? 30_000);

      request.on("response", (response) => {
        status = response.statusCode;
        response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
        response.on("end", () => {
          clearTimeout(timeout);
          const raw = Buffer.concat(chunks).toString("utf8");
          let parsed: unknown = raw;
          try { parsed = raw ? JSON.parse(raw) : null; } catch { /* keep raw */ }
          if (status >= 200 && status < 300) {
            resolve(parsed as T);
          } else {
            const msg = describeHttpError(status, parsed);
            reject(new HttpError(status, parsed, msg));
          }
        });
      });

      request.on("error", (err) => {
        clearTimeout(timeout);
        reject(err);
      });
      request.on("abort", () => {
        clearTimeout(timeout);
        reject(new Error(`Aborted ${method} ${opts.path}`));
      });

      if (bodyBuffer) request.write(bodyBuffer);
      request.end();
    });
  }

  // ── auth ────────────────────────────────────────────────────────────
  register(payload: {
    email: string; password: string;
    display_name?: string; country_code?: string;
    accepted_tos_version: string;
  }) {
    return this.call<unknown>({ method: "POST", path: "/v1/users/register", body: payload, noAuth: true });
  }
  login(payload: { email: string; password: string }) {
    return this.call<{ access_token: string; refresh_token: string; token_type: string }>({
      method: "POST",
      path: "/v1/users/login",
      body: payload,
      noAuth: true
    });
  }
  me() {
    return this.call<unknown>({ path: "/v1/users/me" });
  }
  dashboard() {
    return this.call<unknown>({ path: "/v1/users/me/dashboard" });
  }
  oauthProviders() {
    return this.call<{ providers: Array<{ provider: string; configured: boolean }> }>({ path: "/v1/users/oauth/providers", noAuth: true });
  }
  oauthStart(provider: string) {
    return this.call<{ authorize_url: string; state: string }>({
      method: "POST",
      path: `/v1/users/oauth/${provider}/start`,
      body: {},
      noAuth: true
    });
  }
  oauthDevLogin(provider: string, email?: string) {
    return this.call<{ access_token: string; refresh_token: string }>({
      method: "POST",
      path: `/v1/users/oauth/${provider}/dev-login`,
      body: email ? { email } : {},
      noAuth: true
    });
  }

  // ── devices ──────────────────────────────────────────────────────────
  listDevices() {
    return this.call<unknown>({ path: "/v1/devices" });
  }
  registerDevice(payload: {
    label?: string;
    device_class: string;
    capabilities?: Record<string, unknown>;
    consents?: Record<string, unknown>;
  }) {
    return this.call<{ id: string; [k: string]: unknown }>({
      method: "POST",
      path: "/v1/devices/register",
      body: payload
    });
  }
  getDevice(id: string) {
    return this.call<unknown>({ path: `/v1/devices/${id}` });
  }
  patchDevice(id: string, payload: Record<string, unknown>) {
    return this.call<unknown>({ method: "PATCH", path: `/v1/devices/${id}`, body: payload });
  }
  decommissionDevice(id: string) {
    return this.call<unknown>({ method: "POST", path: `/v1/devices/${id}/decommission`, body: {} });
  }
  issueDeviceToken(id: string) {
    return this.call<{ access_token: string }>({
      method: "POST",
      path: `/v1/devices/${id}/issue-token`,
      body: {}
    });
  }
  postBenchmark(id: string, payload: Record<string, unknown>) {
    return this.call<unknown>({ method: "POST", path: `/v1/devices/${id}/benchmark`, body: payload });
  }

  // ── agent loop (uses device token) ───────────────────────────────────
  agentChallenge(token: string) {
    return this.call<{ nonce: string }>({
      method: "POST",
      path: "/v1/agent/attest/challenge",
      body: {},
      token
    });
  }
  agentVerify(token: string, payload: { signature: string; nonce: string }) {
    return this.call<{ ok: boolean }>({
      method: "POST",
      path: "/v1/agent/attest/verify",
      body: payload,
      token
    });
  }
  agentHeartbeat(token: string, payload: Record<string, unknown>) {
    return this.call<unknown>({
      method: "POST",
      path: "/v1/agent/heartbeat",
      body: payload,
      token
    });
  }
  agentClaimWork(token: string) {
    return this.call<unknown>({ method: "POST", path: "/v1/agent/work/claim", body: {}, token });
  }
  agentSubmitWork(token: string, payload: Record<string, unknown>) {
    return this.call<unknown>({
      method: "POST",
      path: "/v1/agent/work/submit",
      body: payload,
      token
    });
  }

  // ── economics ────────────────────────────────────────────────────────
  shouldWork(payload: Record<string, unknown>) {
    return this.call<{ should_work: boolean; reasons?: string[] }>({
      method: "POST",
      path: "/v1/economics/should-work",
      body: payload
    });
  }
  economicsDevice(id: string) {
    return this.call<unknown>({ path: `/v1/economics/device/${id}` });
  }

  // ── LAN claim ────────────────────────────────────────────────────────
  scanLan() {
    return this.call<unknown>({ method: "POST", path: "/v1/claim/scan", body: {} });
  }
  scanLanResults() {
    return this.call<unknown>({ path: "/v1/claim/scan/results" });
  }
  claimExecute(payload: Record<string, unknown>) {
    return this.call<unknown>({ method: "POST", path: "/v1/claim/execute", body: payload });
  }
  claimExecuteAll(payload: Record<string, unknown>) {
    return this.call<unknown>({ method: "POST", path: "/v1/claim/execute-all", body: payload });
  }
  lanClaimRequest(payload: Record<string, unknown>) {
    return this.call<unknown>({ method: "POST", path: "/v1/lan-claims", body: payload });
  }
  lanClaimVerify(payload: Record<string, unknown>) {
    return this.call<unknown>({ method: "POST", path: "/v1/lan-claims/verify", body: payload });
  }
  lanClaimList() {
    return this.call<unknown>({ path: "/v1/lan-claims" });
  }

  // ── android pairing ─────────────────────────────────────────────────
  androidStatus() {
    return this.call<unknown>({ path: "/v1/android/status" });
  }
  androidDiscover(opts: { window_seconds?: number } = {}) {
    return this.call<unknown>({ method: "POST", path: "/v1/android/discover", body: opts });
  }
  androidDiscoverResults() {
    return this.call<unknown>({ path: "/v1/android/discover/results" });
  }
  androidEnroll(payload: Record<string, unknown>) {
    return this.call<unknown>({ method: "POST", path: "/v1/android/enroll", body: payload });
  }
  androidEnrollMany(payload: Record<string, unknown>) {
    return this.call<unknown>({ method: "POST", path: "/v1/android/enroll-many", body: payload });
  }
  androidAddFriend(payload: Record<string, unknown>) {
    return this.call<unknown>({ method: "POST", path: "/v1/android/friends", body: payload });
  }
  androidVetoIp(ip: string) {
    return this.call<unknown>({
      method: "POST",
      path: `/v1/android/friends/veto/${encodeURIComponent(ip)}`,
      body: {}
    });
  }

  // ── payouts / earnings ──────────────────────────────────────────────
  listPayouts() {
    return this.call<unknown>({ path: "/v1/payouts" });
  }
  payoutRequest() {
    return this.call<unknown>({ method: "POST", path: "/v1/payouts/request", body: {} });
  }
  earnings() {
    return this.call<unknown>({ path: "/v1/payouts" });
  }
}

export const api = new ApiClient();
