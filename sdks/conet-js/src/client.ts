/**
 * Conet enterprise cluster compute API client
 */

import { HttpClient } from './http';
import {
  Cluster,
  ClusterDetail,
  Job,
  JobDetail,
  JobSubmitPayload,
  ApiKey,
  ApiKeyCreated,
  ApiKeyCreatePayload,
  ListOptions,
} from './types';

export interface ConetClientOptions {
  baseUrl?: string;
  timeout?: number;
  maxRetries?: number;
}

/**
 * Conet client for accessing enterprise cluster compute.
 *
 * @example
 * const client = new ConetClient("ent_prod_...");
 * const clusters = await client.listClusters();
 * const job = await client.submitJob({ kind: "hashcrack.range", ... });
 */
export class ConetClient {
  private http: HttpClient;

  constructor(apiKey: string, options?: ConetClientOptions) {
    const baseUrl = options?.baseUrl ?? 'https://api.electromesh.io';
    this.http = new HttpClient(baseUrl, {
      timeout: options?.timeout ?? 30_000,
      maxRetries: options?.maxRetries ?? 3,
      bearerToken: apiKey,
    });
  }

  /**
   * List clusters available to this enterprise
   */
  async listClusters(options?: ListOptions): Promise<Cluster[]> {
    return this.http.get<Cluster[]>('/v1/enterprise/clusters', {
      limit: options?.limit ?? 50,
      status: options?.status,
    });
  }

  /**
   * Get detailed cluster information
   *
   * @param clusterId Cluster ID or handle
   */
  async getCluster(clusterId: string): Promise<ClusterDetail> {
    return this.http.get<ClusterDetail>(`/v1/enterprise/clusters/${clusterId}`);
  }

  /**
   * Submit a compute job to available clusters
   *
   * @param jobSpec Job specification
   *
   * @example
   * const job = await client.submitJob({
   *   kind: "hashcrack.range",
   *   max_budget_cents: 10000,
   *   hashcrack_range: {
   *     algorithm: "sha256",
   *     target_hash: "abc123...",
   *     charset: "0123456789abcdef",
   *     min_length: 6,
   *     max_length: 8,
   *   }
   * });
   */
  async submitJob(jobSpec: JobSubmitPayload): Promise<Job> {
    return this.http.post<Job>('/v1/enterprise/jobs/submit', jobSpec);
  }

  /**
   * List jobs for this enterprise
   */
  async listJobs(options?: ListOptions): Promise<Job[]> {
    return this.http.get<Job[]>('/v1/enterprise/jobs', {
      limit: options?.limit ?? 50,
      status: options?.status,
    });
  }

  /**
   * Get job details and status
   *
   * @param jobId Job ID or handle
   */
  async getJob(jobId: string): Promise<JobDetail> {
    return this.http.get<JobDetail>(`/v1/enterprise/jobs/${jobId}`);
  }

  /**
   * Create a new API key for this enterprise
   *
   * @param payload API key creation parameters
   * @returns New API key (only shown once)
   */
  async createApiKey(payload: ApiKeyCreatePayload): Promise<ApiKeyCreated> {
    return this.http.post<ApiKeyCreated>('/v1/enterprise/api-keys', {
      label: payload.label,
      scopes: payload.scopes ?? ['clusters:read', 'clusters:submit_job'],
      expires_in_days: payload.expires_in_days,
    });
  }

  /**
   * List API keys for this enterprise (masked secrets)
   */
  async listApiKeys(limit?: number): Promise<ApiKey[]> {
    return this.http.get<ApiKey[]>('/v1/enterprise/api-keys', {
      limit: limit ?? 50,
    });
  }

  /**
   * Revoke an API key
   *
   * @param keyId API key ID to revoke
   * @param reason Optional reason for revocation
   */
  async revokeApiKey(keyId: string, reason?: string): Promise<void> {
    const params: Record<string, string> = {};
    if (reason) params['reason'] = reason;
    await this.http.post(`/v1/enterprise/api-keys/${keyId}/revoke`, params);
  }
}
