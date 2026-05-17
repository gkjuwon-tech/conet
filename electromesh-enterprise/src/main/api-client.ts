/**
 * Enterprise HTTP client. Auth = `X-API-Key: em_live_…`.
 * Same Promise+HttpError pattern as the consumer client.
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

interface CallOpts {
  method?: string;
  path: string;
  body?: unknown;
  apiKey?: string | null;
  noAuth?: boolean;
  timeoutMs?: number;
}

function joinUrl(base: string, path: string) {
  if (path.startsWith("http")) return path;
  return `${base.replace(/\/$/, "")}/${path.replace(/^\//, "")}`;
}

export class ApiClient {
  async call<T>(opts: CallOpts): Promise<T> {
    const base = persistence.apiBase;
    const url = joinUrl(base, opts.path);
    const method = opts.method ?? "GET";
    const apiKey = opts.noAuth ? null : (opts.apiKey ?? persistence.apiKey);
    const body = opts.body !== undefined ? Buffer.from(JSON.stringify(opts.body)) : undefined;

    return new Promise<T>((resolve, reject) => {
      const req = net.request({ method, url });
      req.setHeader("Accept", "application/json");
      if (body) req.setHeader("Content-Type", "application/json");
      if (apiKey) req.setHeader("X-API-Key", apiKey);

      const chunks: Buffer[] = [];
      let status = 0;
      const timeout = setTimeout(() => {
        try { req.abort(); } catch { /* */ }
        reject(new Error(`Timeout calling ${method} ${opts.path}`));
      }, opts.timeoutMs ?? 30_000);

      req.on("response", (res) => {
        status = res.statusCode;
        res.on("data", (c) => chunks.push(Buffer.from(c)));
        res.on("end", () => {
          clearTimeout(timeout);
          const raw = Buffer.concat(chunks).toString("utf8");
          let parsed: unknown = raw;
          try { parsed = raw ? JSON.parse(raw) : null; } catch { /* keep raw */ }
          if (status >= 200 && status < 300) resolve(parsed as T);
          else {
            const msg = typeof parsed === "object" && parsed && "detail" in parsed
              ? String((parsed as { detail: unknown }).detail)
              : `HTTP ${status}`;
            reject(new HttpError(status, parsed, msg));
          }
        });
      });
      req.on("error", (err) => { clearTimeout(timeout); reject(err); });
      req.on("abort", () => { clearTimeout(timeout); reject(new Error(`Aborted ${method} ${opts.path}`)); });
      if (body) req.write(body);
      req.end();
    });
  }

  // ── auth / account ───────────────────────────────────────────────
  whoami(apiKey?: string) {
    return this.call<unknown>({ path: "/v1/enterprise/me", apiKey: apiKey ?? null });
  }

  // ── marketplace ──────────────────────────────────────────────────
  marketplaceList(filters: Record<string, unknown> = {}) {
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries(filters)) {
      if (v !== undefined && v !== null && v !== "") q.set(k, String(v));
    }
    const suffix = q.toString();
    return this.call<unknown>({ path: `/v1/marketplace/jobs${suffix ? `?${suffix}` : ""}` });
  }
  marketplaceItem(id: string) {
    return this.call<unknown>({ path: `/v1/marketplace/jobs/${id}` });
  }

  // ── jobs ─────────────────────────────────────────────────────────
  jobs(filters: Record<string, unknown> = {}) {
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries(filters)) {
      if (v !== undefined && v !== null && v !== "") q.set(k, String(v));
    }
    const suffix = q.toString();
    return this.call<unknown>({ path: `/v1/enterprise/jobs${suffix ? `?${suffix}` : ""}` });
  }
  createJob(payload: Record<string, unknown>) {
    return this.call<unknown>({ method: "POST", path: "/v1/enterprise/jobs", body: payload });
  }
  cancelJob(id: string) {
    return this.call<unknown>({ method: "POST", path: `/v1/enterprise/jobs/${id}/cancel`, body: {} });
  }
  getJob(id: string) {
    return this.call<unknown>({ path: `/v1/enterprise/jobs/${id}` });
  }
  jobLogs(id: string) {
    return this.call<unknown>({ path: `/v1/enterprise/jobs/${id}/logs` });
  }
  jobWorkunits(id: string) {
    return this.call<unknown>({ path: `/v1/enterprise/jobs/${id}/workunits` });
  }

  // ── clusters ─────────────────────────────────────────────────────
  clusters() {
    return this.call<unknown>({ path: "/v1/enterprise/clusters" });
  }
  createCluster(payload: Record<string, unknown>) {
    return this.call<unknown>({ method: "POST", path: "/v1/enterprise/clusters", body: payload });
  }
  deleteCluster(id: string) {
    return this.call<unknown>({ method: "DELETE", path: `/v1/enterprise/clusters/${id}` });
  }

  // ── wallet / invoices ───────────────────────────────────────────
  walletBalance() {
    return this.call<unknown>({ path: "/v1/enterprise/wallet" });
  }
  walletDeposit(payload: { amount_cents: number; method?: string }) {
    return this.call<unknown>({ method: "POST", path: "/v1/enterprise/wallet/deposit", body: payload });
  }
  invoices() {
    return this.call<unknown>({ path: "/v1/enterprise/invoices" });
  }

  // ── api keys ────────────────────────────────────────────────────
  apiKeys() {
    return this.call<unknown>({ path: "/v1/enterprise/api-keys" });
  }
  createApiKey(payload: { label?: string; scopes?: string[] }) {
    return this.call<unknown>({ method: "POST", path: "/v1/enterprise/api-keys", body: payload });
  }
  revokeApiKey(id: string) {
    return this.call<unknown>({ method: "DELETE", path: `/v1/enterprise/api-keys/${id}` });
  }
}

export const api = new ApiClient();
