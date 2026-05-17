import { net } from "electron";
import { store } from "./store";
import { DEFAULT_API_BASE } from "./constants";

export class HttpError extends Error {
  status: number;
  code: string;
  detail?: Record<string, unknown>;

  constructor(status: number, code: string, message: string, detail?: Record<string, unknown>) {
    super(message);
    this.name = "HttpError";
    this.status = status;
    this.code = code;
    this.detail = detail;
  }
}

export interface ApiCallOptions {
  method?: "GET" | "POST" | "PATCH" | "DELETE" | "PUT";
  path: string;
  body?: unknown;
  apiKey?: string;
  timeoutMs?: number;
}

export class ApiClient {
  baseUrl: string;

  constructor(baseUrl?: string) {
    this.baseUrl = (baseUrl ?? store.state.apiBase ?? DEFAULT_API_BASE).replace(/\/+$/, "");
  }

  setBaseUrl(url: string): void {
    this.baseUrl = url.replace(/\/+$/, "");
  }

  call<T = unknown>(opts: ApiCallOptions): Promise<T> {
    const url = `${this.baseUrl}${opts.path}`;
    const headers: Record<string, string> = { Accept: "application/json" };

    const apiKey = opts.apiKey ?? store.state.apiKey;
    if (apiKey) headers["X-Api-Key"] = apiKey;
    if (opts.body !== undefined) headers["Content-Type"] = "application/json";

    return new Promise<T>((resolve, reject) => {
      const request = net.request({ method: opts.method ?? "GET", url });
      for (const [k, v] of Object.entries(headers)) request.setHeader(k, v);

      const chunks: Buffer[] = [];
      let status = 0;
      const timer = setTimeout(() => {
        request.abort();
        reject(new HttpError(0, "timeout", `request timed out: ${opts.method ?? "GET"} ${opts.path}`));
      }, opts.timeoutMs ?? 30_000);

      request.on("response", (response) => {
        status = response.statusCode;
        response.on("data", (c) => chunks.push(c as Buffer));
        response.on("end", () => {
          clearTimeout(timer);
          const text = Buffer.concat(chunks).toString("utf8");
          let data: unknown = text;
          if (text && response.headers["content-type"]?.toString().includes("application/json")) {
            try {
              data = JSON.parse(text);
            } catch {
              /* leave raw */
            }
          }
          if (status >= 200 && status < 300) {
            resolve(data as T);
            return;
          }
          const detail = (typeof data === "object" && data) ? (data as Record<string, unknown>) : undefined;
          const code = (detail?.code as string) ?? `http_${status}`;
          const message = (detail?.message as string) ?? `HTTP ${status} ${opts.method ?? "GET"} ${opts.path}`;
          reject(new HttpError(status, code, message, detail));
        });
      });

      request.on("error", (err) => {
        clearTimeout(timer);
        reject(new HttpError(0, "network", err.message));
      });

      if (opts.body !== undefined) request.write(JSON.stringify(opts.body));
      request.end();
    });
  }

  enterpriseMe() {
    return this.call<{
      id: string;
      name: string;
      slug: string;
      status: string;
      contact_email: string;
      compliance_tier: string;
      monthly_spend_cents: number;
      credit_balance_cents: number;
      spend_cap_cents: number | null;
      allowed_workload_kinds: string[];
    }>({ path: "/v1/enterprise/me" });
  }

  enterpriseStats() {
    return this.call<{
      jobs_active: number;
      jobs_completed_30d: number;
      spend_30d_cents: number;
      avg_runtime_seconds_30d: number;
      success_rate_30d: number;
    }>({ path: "/v1/enterprise/me/stats" });
  }

  marketplaceSearch(filt: MarketplaceFilter) {
    return this.call<MarketplacePage>({
      method: "POST",
      path: "/v1/marketplace/search",
      body: filt
    });
  }

  marketplaceQuote(payload: { cluster_ids: string[]; hours: number }) {
    return this.call<Quote[]>({
      method: "POST",
      path: "/v1/marketplace/quote",
      body: payload
    });
  }

  listJobs(limit = 50) {
    return this.call<JobPublic[]>({ path: `/v1/jobs?limit=${limit}` });
  }

  getJob(id: string) {
    return this.call<JobDetail>({ path: `/v1/jobs/${id}` });
  }

  jobWorkunits(id: string) {
    return this.call<WorkUnitPublic[]>({ path: `/v1/jobs/${id}/workunits` });
  }

  submitJob(payload: Record<string, unknown>) {
    return this.call<JobDetail>({
      method: "POST",
      path: "/v1/jobs",
      body: payload
    });
  }

  cancelJob(id: string, reason?: string) {
    return this.call<JobPublic>({
      method: "POST",
      path: `/v1/jobs/${id}/cancel`,
      body: { reason }
    });
  }

  finalizeJob(id: string) {
    return this.call<JobPublic>({
      method: "POST",
      path: `/v1/jobs/${id}/finalize`
    });
  }

  listApiKeys() {
    return this.call<ApiKeyPublic[]>({ path: "/v1/enterprise/me/api-keys" });
  }

  createApiKey(payload: { label: string; scopes: string[]; expires_in_days?: number }) {
    return this.call<ApiKeyCreated>({
      method: "POST",
      path: "/v1/enterprise/me/api-keys",
      body: payload
    });
  }

  revokeApiKey(id: string) {
    return this.call<void>({
      method: "DELETE",
      path: `/v1/enterprise/me/api-keys/${id}`
    });
  }
}

export interface MarketplaceFilter {
  min_h100_equivalent?: number;
  max_h100_equivalent?: number;
  min_price_usd_hour?: number;
  max_price_usd_hour?: number;
  min_reliability?: number;
  required_capabilities?: string[];
  region_hint?: string;
  sort?: string;
  cursor?: string | null;
  limit?: number;
}

export interface ClusterCard {
  id: string;
  handle: string;
  sequence_no: number;
  status: string;
  member_count: number;
  target_size: number;
  h100_equivalent: number;
  aggregate_cpu_gflops: number;
  aggregate_gpu_gflops: number;
  aggregate_ram_mb: number;
  aggregate_vram_mb: number;
  aggregate_hash_mhs_sha256: number;
  aggregate_network_mbps: number;
  reliability_score: number;
  trust_score: number;
  diversity_index: number;
  price_usd_per_hour: number;
  region_hint: string | null;
  available_at: string | null;
  composition: Record<string, number>;
  capability_summary: Record<string, number>;
}

export interface MarketplacePage {
  items: ClusterCard[];
  next_cursor: string | null;
  total_estimate: number;
}

export interface Quote {
  cluster: ClusterCard;
  hours: number;
  usd_total: number;
  expected_h100_hours: number;
  confidence: number;
}

export interface JobPublic {
  id: string;
  handle: string;
  enterprise_id: string;
  kind: string;
  status: string;
  title: string | null;
  description: string | null;
  target_cluster_count: number;
  target_h100_equivalent: number;
  max_budget_cents: number;
  max_runtime_seconds: number;
  workunit_total: number;
  workunit_completed: number;
  workunit_failed: number;
  spent_cents: number;
  paid_to_users_cents: number;
  platform_fee_cents: number;
  submitted_at: string | null;
  started_at: string | null;
  finished_at: string | null;
  deadline_at: string | null;
}

export interface JobDetail extends JobPublic {
  input_manifest: Record<string, unknown>;
  isolation_policy: Record<string, unknown>;
  output_manifest: Record<string, unknown>;
}

export interface WorkUnitPublic {
  id: string;
  handle: string;
  job_id: string;
  sequence_no: number;
  status: string;
  weight: number;
  expected_runtime_seconds: number;
  redundancy_required: number;
  redundancy_satisfied: number;
  final_result_hash: string | null;
  consensus_score: number | null;
  dispatched_at: string | null;
  completed_at: string | null;
  deadline_at: string | null;
}

export interface ApiKeyPublic {
  id: string;
  label: string;
  key_prefix: string;
  scopes: string[];
  last_used_at: string | null;
  revoked_at: string | null;
  expires_at: string | null;
  is_active: boolean;
}

export interface ApiKeyCreated extends ApiKeyPublic {
  api_key: string;
}

export const apiClient = new ApiClient();
