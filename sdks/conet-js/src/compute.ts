/**
 * ``compute.run`` — one-liner compute submission for SDK consumers.
 *
 * @example
 *   import { compute } from "conet";
 *
 *   const result = await compute.run({
 *     apiKey: "em_cluster_…",
 *     payload: {
 *       kind: "hashcrack.range",
 *       hashcrack_range: { ... },
 *     },
 *   });
 *   console.log(result.status, result.output);
 *
 * That's it. No client to construct, no manual polling — by default the
 * call resolves when the run reaches a terminal state. Pass ``wait: false``
 * for fire-and-forget semantics.
 */

import { DEFAULT_BASE_URL } from './client.js';
import { TimeoutError } from './errors.js';
import { HttpClient } from './http.js';
import type {
  ComputePayload,
  ComputeRunCreated,
  ComputeRunPublic,
  JobStatus,
} from './types.js';

const DEFAULT_POLL_INTERVAL_MS = 2_000;
const DEFAULT_RUN_TIMEOUT_MS = 3_600_000; // 1 hour

const TERMINAL_STATUSES: ReadonlySet<JobStatus> = new Set<JobStatus>([
  'succeeded',
  'failed',
  'cancelled',
  'timed_out',
  'rejected',
]);

export interface ClusterClientOptions {
  baseUrl?: string;
  timeout?: number;
  maxRetries?: number;
}

/**
 * Async client authenticated with a cluster (``em_cluster_…``) key.
 */
export class ClusterClient {
  private http: HttpClient;
  readonly apiKey: string;

  constructor(apiKey: string, options?: ClusterClientOptions) {
    if (!apiKey) {
      throw new Error('apiKey is required');
    }
    if (!apiKey.startsWith('em_cluster_')) {
      throw new Error(
        'ClusterClient requires an em_cluster_ key — purchase one via ' +
          'ConetClient#purchaseCluster(clusterId, ...)'
      );
    }
    this.apiKey = apiKey;
    this.http = new HttpClient(options?.baseUrl ?? DEFAULT_BASE_URL, {
      timeout: options?.timeout ?? 30_000,
      maxRetries: options?.maxRetries ?? 3,
      apiKey,
    });
  }

  async submitRun(payload: ComputePayload): Promise<ComputeRunCreated> {
    return this.http.post<ComputeRunCreated>(
      '/v1/compute/run',
      payload as unknown as Record<string, unknown>
    );
  }

  async getRun(runId: string): Promise<ComputeRunPublic> {
    return this.http.get<ComputeRunPublic>(`/v1/compute/runs/${runId}`);
  }

  async cancelRun(runId: string, reason?: string): Promise<ComputeRunPublic> {
    return this.http.post<ComputeRunPublic>(
      `/v1/compute/runs/${runId}/cancel`,
      reason ? { reason } : {}
    );
  }

  /**
   * Submit a workload and resolve when it reaches a terminal status.
   *
   * Throws ``TimeoutError`` if ``timeoutMs`` elapses first.
   */
  async runAndWait(
    payload: ComputePayload,
    options?: { timeoutMs?: number; pollIntervalMs?: number }
  ): Promise<ComputeRunPublic> {
    const timeoutMs = options?.timeoutMs ?? DEFAULT_RUN_TIMEOUT_MS;
    const pollMs = options?.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    const deadline = Date.now() + timeoutMs;

    const created = await this.submitRun(payload);
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const run = await this.getRun(created.run_id);
      if (TERMINAL_STATUSES.has(run.status)) {
        return run;
      }
      if (Date.now() >= deadline) {
        throw new TimeoutError(
          `run ${created.run_id} did not finish within ${timeoutMs}ms`
        );
      }
      await new Promise<void>((r) => setTimeout(r, pollMs));
    }
  }
}

export interface RunOptions {
  /** Cluster key, ``em_cluster_…``. */
  apiKey: string;
  payload: ComputePayload;
  baseUrl?: string;
  /** When false, returns immediately with the queued handle. Default: true. */
  wait?: boolean;
  timeoutMs?: number;
  pollIntervalMs?: number;
}

/**
 * One-liner compute submission.
 *
 * Returns a ``ComputeRunPublic`` when ``wait`` is true (default), or a
 * ``ComputeRunCreated`` envelope when ``wait`` is false.
 */
export async function run(
  options: RunOptions
): Promise<ComputeRunPublic | ComputeRunCreated> {
  const client = new ClusterClient(options.apiKey, {
    baseUrl: options.baseUrl,
  });
  if (options.wait === false) {
    return client.submitRun(options.payload);
  }
  return client.runAndWait(options.payload, {
    timeoutMs: options.timeoutMs,
    pollIntervalMs: options.pollIntervalMs,
  });
}

export const compute = { run };
