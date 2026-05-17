import { store } from "./store.mjs";

export class HttpError extends Error {
  constructor(status, code, message, detail) {
    super(message);
    this.status = status;
    this.code = code;
    this.detail = detail;
  }
}

async function request({ method = "GET", path, body, token, apiKey, timeoutMs = 30_000 }) {
  const state = await store.get();
  const base = (state.apiBase || "http://localhost:8080").replace(/\/+$/, "");
  const url = `${base}${path}`;
  const headers = { Accept: "application/json" };
  if (token) headers["Authorization"] = `Bearer ${token}`;
  if (apiKey) headers["X-Api-Key"] = apiKey;
  if (body !== undefined) headers["Content-Type"] = "application/json";

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  let resp;
  try {
    resp = await fetch(url, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: ctrl.signal
    });
  } catch (err) {
    clearTimeout(timer);
    throw new HttpError(0, "network", `${method} ${path}: ${err.message}`);
  }
  clearTimeout(timer);

  const text = await resp.text();
  let data = text;
  if (text && resp.headers.get("content-type")?.includes("application/json")) {
    try {
      data = JSON.parse(text);
    } catch {
      /* leave as text */
    }
  }
  if (resp.ok) return data;
  const code = data?.code ?? `http_${resp.status}`;
  const message = data?.detail ? JSON.stringify(data.detail) : data?.message ?? `HTTP ${resp.status} ${method} ${path}`;
  throw new HttpError(resp.status, code, message, data);
}

export const api = {
  raw: request,

  async login(email, password) {
    return request({
      method: "POST",
      path: "/v1/users/login",
      body: { email, password }
    });
  },
  async register(payload) {
    return request({
      method: "POST",
      path: "/v1/users/register",
      body: payload
    });
  },
  async me(token) {
    return request({ path: "/v1/users/me", token });
  },
  async dashboard(token) {
    return request({ path: "/v1/users/me/dashboard", token });
  },
  async listDevices(token) {
    return request({ path: "/v1/devices", token });
  },
  async registerDevice(token, payload) {
    return request({
      method: "POST",
      path: "/v1/devices/register",
      body: payload,
      token
    });
  },
  async issueDeviceToken(token, deviceId) {
    return request({
      method: "POST",
      path: `/v1/devices/${deviceId}/issue-token`,
      token
    });
  },
  async submitBenchmark(token, deviceId, payload) {
    return request({
      method: "POST",
      path: `/v1/devices/${deviceId}/benchmark`,
      body: payload,
      token
    });
  },
  async attestChallenge(deviceToken) {
    return request({
      method: "POST",
      path: "/v1/agent/attest/challenge",
      token: deviceToken
    });
  },
  async attestVerify(deviceToken, body) {
    return request({
      method: "POST",
      path: "/v1/agent/attest/verify",
      body,
      token: deviceToken
    });
  },
  async heartbeat(deviceToken, body) {
    return request({
      method: "POST",
      path: "/v1/agent/heartbeat",
      body,
      token: deviceToken
    });
  },
  async claimWork(deviceToken, max = 1) {
    return request({
      method: "POST",
      path: `/v1/agent/work/claim?max_units=${max}`,
      token: deviceToken
    });
  },
  async submitWork(deviceToken, body) {
    return request({
      method: "POST",
      path: "/v1/agent/work/submit",
      body,
      token: deviceToken
    });
  },
  async runBundler(apiKey) {
    return request({
      method: "POST",
      path: "/v1/admin/run/bundler",
      apiKey
    });
  },
  async finalizeJob(apiKey, jobId) {
    return request({
      method: "POST",
      path: `/v1/jobs/${jobId}/finalize`,
      apiKey
    });
  },
  async getJob(apiKey, jobId) {
    return request({ path: `/v1/jobs/${jobId}`, apiKey });
  },
  async listJobs(apiKey) {
    return request({ path: "/v1/jobs?limit=50", apiKey });
  },
  async listWorkunits(apiKey, jobId) {
    return request({ path: `/v1/jobs/${jobId}/workunits`, apiKey });
  },
  async marketplaceSearch(apiKey, body = {}) {
    return request({
      method: "POST",
      path: "/v1/marketplace/search",
      body: { sort: "price_asc", limit: 50, ...body },
      apiKey
    });
  },
  async submitJob(apiKey, body) {
    return request({
      method: "POST",
      path: "/v1/jobs",
      body,
      apiKey
    });
  },
  async cancelJob(apiKey, jobId, reason) {
    return request({
      method: "POST",
      path: `/v1/jobs/${jobId}/cancel`,
      body: { reason },
      apiKey
    });
  },
  async enterpriseMe(apiKey) {
    return request({ path: "/v1/enterprise/me", apiKey });
  },
  async adminStats(apiKey) {
    return request({ path: "/v1/admin/stats", apiKey });
  },
  async health() {
    return request({ path: "/healthz" });
  }
};
