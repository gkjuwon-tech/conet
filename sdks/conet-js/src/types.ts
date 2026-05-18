/**
 * Type definitions for the Conet (ElectroMesh) API.
 */

export type ApiKeyKind = 'access' | 'cluster';

export type JobStatus =
  | 'draft'
  | 'queued'
  | 'leasing'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'cancelled'
  | 'timed_out'
  | 'rejected';

export interface Cluster {
  id: string;
  handle: string;
  sequence_no: number;
  status: 'forming' | 'available' | 'leased' | 'draining' | 'retired';
  member_count: number;
  target_size: number;
  h100_equivalent: number;
  reliability_score: number;
  trust_score: number;
  price_usd_per_hour: number;
  region_hint?: string;
  available_at?: string;
}

export interface ClusterDetail extends Cluster {
  aggregate_cpu_gflops: number;
  aggregate_gpu_gflops: number;
  aggregate_ram_mb: number;
  aggregate_vram_mb: number;
  aggregate_hash_mhs_sha256: number;
  aggregate_network_mbps: number;
  diversity_index: number;
  price_breakdown?: Record<string, number>;
  members?: ClusterMember[];
}

export interface ClusterMember {
  device_class: string;
  h100_equivalent: number;
  weight: number;
  reliability_score: number;
  trust_score: number;
}

export interface ClusterPurchasePayload {
  /** Human-readable label, e.g. "render-queue-prod". */
  label: string;
  /** Hard cap on spend for the resulting cluster key, in USD cents. */
  budget_cents: number;
  expires_in_days?: number;
}

export interface ClusterPurchaseResult {
  id: string;
  label: string;
  /** Plaintext em_cluster_… key. Shown exactly once — store it. */
  api_key: string;
  key_prefix: string;
  kind: 'cluster';
  bound_cluster_id: string;
  max_budget_cents: number;
  scopes: string[];
  expires_at: string | null;
}

export interface ApiKey {
  id: string;
  label: string;
  key_prefix: string;
  scopes: string[];
  kind: ApiKeyKind;
  bound_cluster_id: string | null;
  max_budget_cents: number;
  spent_cents: number;
  last_used_at: string | null;
  revoked_at: string | null;
  expires_at: string | null;
  is_active: boolean;
}

export interface ApiKeyCreated {
  id: string;
  label: string;
  /** Plaintext key. Shown exactly once. */
  api_key: string;
  key_prefix: string;
  scopes: string[];
  kind: ApiKeyKind;
  bound_cluster_id: string | null;
  expires_at: string | null;
}

export interface ApiKeyCreatePayload {
  label: string;
  scopes?: string[];
  expires_in_days?: number;
}

export interface Job {
  id: string;
  handle: string;
  enterprise_id: string;
  kind: string;
  status: JobStatus;
  title?: string;
  description?: string;
  target_cluster_count: number;
  target_h100_equivalent: number;
  max_budget_cents: number;
  max_runtime_seconds: number;
  spent_cents: number;
  paid_to_users_cents: number;
  platform_fee_cents: number;
  submitted_at?: string;
  started_at?: string;
  finished_at?: string;
  deadline_at?: string;
}

export interface JobDetail extends Job {
  input_manifest: Record<string, unknown>;
  output_manifest: Record<string, unknown>;
}

export interface JobSubmitPayload {
  kind: string;
  title?: string;
  description?: string;
  target_cluster_count?: number;
  target_h100_equivalent?: number;
  max_budget_cents: number;
  max_runtime_seconds?: number;
  redundancy?: number;
  consensus_threshold?: number;
  hashcrack_range?: Record<string, unknown>;
  hashcrack_dict?: Record<string, unknown>;
  fhe_share?: Record<string, unknown>;
  raw_manifest?: Record<string, unknown>;
  isolation_policy?: Record<string, unknown>;
  callback_url?: string;
}

/** Payload accepted by ``POST /v1/compute/run`` (cluster-key endpoint). */
export interface ComputePayload {
  kind: string;
  label?: string;
  max_budget_cents?: number;
  max_runtime_seconds?: number;
  redundancy?: number;
  hashcrack_range?: Record<string, unknown>;
  hashcrack_dict?: Record<string, unknown>;
  fhe_share?: Record<string, unknown>;
  raw_manifest?: Record<string, unknown>;
  callback_url?: string;
}

export interface ComputeRunCreated {
  run_id: string;
  job_id: string;
  job_handle: string;
  cluster_id: string;
  status: JobStatus;
  submitted_at: string | null;
}

export interface ComputeRunPublic {
  run_id: string;
  job_id: string;
  job_handle: string;
  cluster_id: string;
  status: JobStatus;
  label: string | null;
  kind: string;
  workunit_total: number;
  workunit_completed: number;
  workunit_failed: number;
  spent_cents: number;
  max_budget_cents: number;
  max_runtime_seconds: number;
  submitted_at: string | null;
  started_at: string | null;
  finished_at: string | null;
  output: Record<string, unknown>;
}

export interface ListOptions {
  limit?: number;
  status?: string;
}

export interface ListApiKeysOptions extends ListOptions {
  kind?: ApiKeyKind;
}
