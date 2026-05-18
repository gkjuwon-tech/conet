/**
 * Conet enterprise control-plane API client.
 *
 * Takes an ``em_live_…`` access key. For workload submission, use
 * ``compute.run`` (one-liner) or ``ClusterClient``.
 */

import { HttpClient } from './http.js';
import type {
  ApiKey,
  ApiKeyCreated,
  ApiKeyCreatePayload,
  ApiKeyKind,
  Cluster,
  ClusterDetail,
  ClusterPurchasePayload,
  ClusterPurchaseResult,
  Job,
  JobDetail,
  JobSubmitPayload,
  ListApiKeysOptions,
  ListOptions,
} from './types.js';

export const DEFAULT_BASE_URL = 'https://api.electromesh.io';

export interface ConetClientOptions {
  baseUrl?: string;
  timeout?: number;
  maxRetries?: number;
}

/**
 * Async client for Conet's enterprise control-plane API.
 *
 * @example
 *   const c = new ConetClient("em_live_…");
 *   const clusters = await c.listClusters();
 *   const purchase = await c.purchaseCluster(clusters[0].id, {
 *     label: "render-queue", budget_cents: 50_000,
 *   });
 *   // purchase.api_key is your new em_cluster_… key
 */
export class ConetClient {
  private http: HttpClient;

  constructor(apiKey: string, options?: ConetClientOptions) {
    if (!apiKey) {
      throw new Error('apiKey is required');
    }
    if (apiKey.startsWith('em_cluster_')) {
      throw new Error(
        'ConetClient takes an em_live_ access key; for compute use ' +
          'compute.run() with your em_cluster_ key instead.'
      );
    }
    this.http = new HttpClient(options?.baseUrl ?? DEFAULT_BASE_URL, {
      timeout: options?.timeout ?? 30_000,
      maxRetries: options?.maxRetries ?? 3,
      apiKey,
    });
  }

  // ── clusters ────────────────────────────────────────────────────────

  async listClusters(options?: ListOptions): Promise<Cluster[]> {
    return this.http.get<Cluster[]>('/v1/clusters', {
      limit: options?.limit ?? 50,
      status: options?.status,
    });
  }

  async getCluster(clusterId: string): Promise<ClusterDetail> {
    return this.http.get<ClusterDetail>(`/v1/clusters/${clusterId}`);
  }

  /**
   * Reserve a cluster and mint a fresh ``em_cluster_…`` key.
   * The result's ``api_key`` field is shown exactly once.
   */
  async purchaseCluster(
    clusterId: string,
    payload: ClusterPurchasePayload
  ): Promise<ClusterPurchaseResult> {
    return this.http.post<ClusterPurchaseResult>(
      `/v1/enterprise/clusters/${clusterId}/purchase`,
      payload as unknown as Record<string, unknown>
    );
  }

  // ── jobs (legacy auto-lease flow) ───────────────────────────────────

  /**
   * Submit a job that auto-leases clusters (legacy flow).
   * For workloads against a pre-purchased cluster prefer ``compute.run``.
   */
  async submitJob(jobSpec: JobSubmitPayload): Promise<JobDetail> {
    return this.http.post<JobDetail>(
      '/v1/jobs',
      jobSpec as unknown as Record<string, unknown>
    );
  }

  async listJobs(options?: ListOptions): Promise<Job[]> {
    return this.http.get<Job[]>('/v1/jobs', {
      limit: options?.limit ?? 50,
      status_filter: options?.status,
    });
  }

  async getJob(jobId: string): Promise<JobDetail> {
    return this.http.get<JobDetail>(`/v1/jobs/${jobId}`);
  }

  async cancelJob(jobId: string, reason?: string): Promise<Job> {
    return this.http.post<Job>(
      `/v1/jobs/${jobId}/cancel`,
      reason ? { reason } : {}
    );
  }

  // ── api key management ──────────────────────────────────────────────

  async createApiKey(payload: ApiKeyCreatePayload): Promise<ApiKeyCreated> {
    return this.http.post<ApiKeyCreated>('/v1/enterprise/me/api-keys', {
      label: payload.label,
      scopes:
        payload.scopes ?? ['clusters:read', 'clusters:submit_job', 'jobs:read'],
      expires_in_days: payload.expires_in_days,
    });
  }

  async listApiKeys(options?: ListApiKeysOptions): Promise<ApiKey[]> {
    const params: Record<string, unknown> = {};
    if (options?.kind) params['kind'] = options.kind;
    return this.http.get<ApiKey[]>('/v1/enterprise/me/api-keys', params);
  }

  async listClusterKeys(): Promise<ApiKey[]> {
    return this.http.get<ApiKey[]>('/v1/enterprise/me/cluster-keys');
  }

  async revokeApiKey(keyId: string, reason?: string): Promise<void> {
    await this.http.delete(
      `/v1/enterprise/me/api-keys/${keyId}`,
      reason ? { reason } : undefined
    );
  }

  async revokeClusterKey(keyId: string): Promise<void> {
    await this.http.delete(`/v1/enterprise/me/cluster-keys/${keyId}`);
  }
}

export type { ApiKeyKind };
