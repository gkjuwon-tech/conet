import { net } from "electron";
import { store } from "./store";
import { DEFAULT_API_BASE } from "./constants";

export interface ApiCallOptions {
  method?: "GET" | "POST" | "PATCH" | "DELETE" | "PUT";
  path: string;
  body?: unknown;
  token?: string;
  headers?: Record<string, string>;
  timeoutMs?: number;
}

export interface ApiError extends Error {
  status: number;
  code: string;
  detail?: Record<string, unknown>;
}

export class HttpError extends Error implements ApiError {
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

export class ApiClient {
  baseUrl: string;

  constructor(baseUrl?: string) {
    // 환경변수(EM_API_BASE)가 있으면 캐시(apiBase)를 무시한다.
    const envApiBase = process.env.EM_API_BASE;
    const resolved =
      baseUrl ??
      (envApiBase ? envApiBase : undefined) ??
      store.state.apiBase ??
      DEFAULT_API_BASE;

    // baseUrl에 혹시라도 공백/개행이 섞여 있으면 Invalid URL/요청 실패로 이어진다.
    this.baseUrl = resolved.replace(/\s+/g, "").replace(/\/+$/, "");
  }

  setBaseUrl(url: string): void {
    this.baseUrl = url.replace(/\s+/g, "").trim().replace(/\/+$/, "");
  }

  async call<T = unknown>(opts: ApiCallOptions): Promise<T> {
    const url = `${this.baseUrl}${opts.path}`;
    // 디버그: 실제 호출 baseUrl/endpoint 확인(캐시 잔상 여부 검증용)
    // eslint-disable-next-line no-console
    console.log(`[api] ${opts.method ?? "GET"} ${url}`);
    const headers: Record<string, string> = {
      Accept: "application/json",
      ...(opts.headers ?? {})
    };

    const token = opts.token ?? store.state.userToken;
    if (token) headers["Authorization"] = `Bearer ${token}`;
    if (opts.body !== undefined) headers["Content-Type"] = "application/json";

    return new Promise<T>((resolve, reject) => {
      const request = net.request({
        method: opts.method ?? "GET",
        url
      });
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
          const trimmed = text.trim();
          if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
            try {
              data = JSON.parse(text);
            } catch {
              /* keep raw */
            }
          }
          if (status >= 200 && status < 300) {
            resolve(data as T);
            return;
          }
          const detail = (typeof data === "object" && data) ? (data as Record<string, unknown>) : undefined;
          const code =
            (detail?.code as string) ?? `http_${status}`;
          const message =
            (detail?.message as string) ?? `HTTP ${status} ${opts.method ?? "GET"} ${opts.path}`;
          reject(new HttpError(status, code, message, detail));
        });
      });

      request.on("error", (err) => {
        clearTimeout(timer);
        reject(new HttpError(0, "network", err.message));
      });

      if (opts.body !== undefined) {
        request.write(JSON.stringify(opts.body));
      }
      request.end();
    });
  }

  async login(email: string, password: string) {
    return this.call<{ access_token: string; refresh_token: string; expires_in: number }>({
      method: "POST",
      path: "/v1/users/login",
      body: { email, password }
    });
  }

  async register(payload: {
    email: string;
    password: string;
    display_name?: string;
    accepted_tos_version: string;
    country_code?: string;
    timezone?: string;
    locale?: string;
  }) {
    return this.call<{ id: string; email: string }>({
      method: "POST",
      path: "/v1/users/register",
      body: payload
    });
  }

  async me() {
    return this.call<{ id: string; email: string; display_name?: string }>({
      method: "GET",
      path: "/v1/users/me"
    });
  }

  async dashboard() {
    return this.call<{
      user: { id: string; email: string; display_name?: string };
      wallet: {
        available_cents: number;
        pending_cents: number;
        held_cents: number;
        lifetime_earned_cents: number;
        lifetime_paid_cents: number;
        last_activity_at: string | null;
      };
      devices_online: number;
      devices_total: number;
      last_24h_earnings_cents: number;
      pending_payout_cents: number;
    }>({ path: "/v1/users/me/dashboard" });
  }

  async listDevices() {
    return this.call<DeviceSummary[]>({ path: "/v1/devices" });
  }

  async getDevice(id: string) {
    return this.call<DeviceDetail>({ path: `/v1/devices/${id}` });
  }

  async registerDevice(payload: DeviceRegisterPayload) {
    return this.call<DeviceDetail>({
      method: "POST",
      path: "/v1/devices/register",
      body: payload
    });
  }

  async issueDeviceToken(deviceId: string) {
    return this.call<{ token: string; expires_in: number; device_handle: string }>({
      method: "POST",
      path: `/v1/devices/${deviceId}/issue-token`
    });
  }

  async submitBenchmark(deviceId: string, payload: BenchmarkSubmit) {
    return this.call<DeviceDetail>({
      method: "POST",
      path: `/v1/devices/${deviceId}/benchmark`,
      body: payload
    });
  }

  async decommissionDevice(deviceId: string) {
    return this.call<DeviceSummary>({
      method: "POST",
      path: `/v1/devices/${deviceId}/decommission`
    });
  }

  async listPayouts() {
    return this.call<{ items: PayoutItem[]; next_cursor: string | null }>({
      path: "/v1/payouts"
    });
  }

  async requestPayout() {
    return this.call<PayoutItem>({
      method: "POST",
      path: "/v1/payouts/request",
      body: { method: "stripe", confirm: true }
    });
  }

  async deviceHeartbeat(token: string, payload: HeartbeatPayload) {
    return this.call<{ ok: true; device_id: string }>({
      method: "POST",
      path: "/v1/agent/heartbeat",
      token,
      body: payload
    });
  }

  async claimWork(token: string, max = 1) {
    return this.call<DispatchedUnit[]>({
      method: "POST",
      path: `/v1/agent/work/claim?max_units=${max}`,
      token
    });
  }

  async submitWork(token: string, payload: SubmitWorkPayload) {
    return this.call<{
      workunit_id: string;
      consensus_achieved: boolean;
      consensus_score: number;
      winning_hash: string | null;
    }>({
      method: "POST",
      path: "/v1/agent/work/submit",
      token,
      body: payload
    });
  }

  async attestChallenge(token: string) {
    return this.call<{ challenge_id: string; nonce: string; difficulty: number; method: string }>({
      method: "POST",
      path: "/v1/agent/attest/challenge",
      token
    });
  }

  async attestVerify(token: string, payload: { nonce: string; candidate?: string; signature_hex?: string; difficulty?: number }) {
    return this.call<{ ok: boolean; verified_at: string }>({
      method: "POST",
      path: "/v1/agent/attest/verify",
      token,
      body: payload
    });
  }

  async lanClaimRequest(payload: {
    lan_fingerprint: string;
    label?: string;
    gateway_mac?: string;
    advertised_subnet?: string;
  }) {
    return this.call<LanClaimRecord>({
      method: "POST",
      path: "/v1/lan-claims",
      body: payload
    });
  }

  async lanClaimVerify(payload: { lan_fingerprint: string; otp: string }) {
    return this.call<LanClaimRecord>({
      method: "POST",
      path: "/v1/lan-claims/verify",
      body: payload
    });
  }

  async lanClaimList() {
    return this.call<LanClaimRecord[]>({ path: "/v1/lan-claims" });
  }
}

export interface LanClaimRecord {
  id: string;
  lan_fingerprint: string;
  status: "pending_otp" | "verified" | "expired" | "revoked" | "disputed";
  label: string | null;
  otp_expires_at: string | null;
  grace_until: string | null;
  verified_at: string | null;
  advertised_subnet: string | null;
  gateway_ip: string | null;
  gateway_mac: string | null;
  is_active: boolean;
  delivered_otp_dev: string | null;
}

export interface DeviceSummary {
  id: string;
  handle: string;
  label: string | null;
  device_class: string;
  status: string;
  vendor: string | null;
  model: string | null;
  h100_equivalent: number;
  reliability_score: number;
  trust_score: number;
  contribution_score: number;
  revenue_cents_lifetime: number;
  workunits_completed: number;
  last_seen_at: string | null;
  last_benchmark_at: string | null;
  auto_join_enabled: boolean;
}

export interface DeviceDetail extends DeviceSummary {
  cpu_cores: number;
  cpu_ghz: number;
  ram_mb: number;
  storage_gb: number;
  gpu_model: string | null;
  gpu_vram_mb: number;
  cpu_gflops: number;
  gpu_gflops: number;
  hash_mhs_sha256: number;
  hash_mhs_argon2: number;
  network_mbps_down: number;
  network_mbps_up: number;
  network_latency_ms: number;
  consents: Record<string, unknown>;
  capabilities: Record<string, unknown>;
}

export interface DeviceRegisterPayload {
  label?: string;
  device_class: string;
  vendor?: string;
  model?: string;
  firmware?: string;
  os?: string;
  arch?: string;
  public_key?: string;
  consents?: Record<string, unknown>;
  capabilities?: Record<string, unknown>;
  lan_fingerprint?: string;
}

export interface BenchmarkSubmit {
  cpu_cores: number;
  cpu_ghz: number;
  ram_mb: number;
  storage_gb: number;
  gpu_model?: string;
  gpu_vram_mb?: number;
  cpu_gflops: number;
  gpu_gflops?: number;
  hash_mhs_sha256: number;
  hash_mhs_argon2?: number;
  network_mbps_down: number;
  network_mbps_up: number;
  network_latency_ms: number;
  avg_idle_hours_per_day?: number;
  proof?: string;
}

export interface HeartbeatPayload {
  cpu_usage_pct: number;
  gpu_usage_pct?: number;
  ram_usage_pct?: number;
  temperature_c?: number | null;
  power_watts?: number | null;
  rssi_dbm?: number | null;
  download_mbps?: number | null;
  upload_mbps?: number | null;
  extras?: Record<string, unknown>;
}

export interface DispatchedUnit {
  workunit_id: string;
  handle: string;
  payload: Record<string, unknown>;
  expected_runtime_seconds: number;
}

export interface SubmitWorkPayload {
  workunit_id: string;
  runtime_ms: number;
  result: Record<string, unknown>;
  result_hash: string;
  proof?: string;
  error_code?: string;
  error_message?: string;
}

export interface PayoutItem {
  id: string;
  handle: string;
  amount_cents: number;
  currency: string;
  status: string;
  period_start: string;
  period_end: string;
  method: string;
  initiated_at: string | null;
  settled_at: string | null;
  failure_reason: string | null;
}

export const apiClient = new ApiClient();
