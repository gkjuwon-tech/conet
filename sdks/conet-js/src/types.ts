/**
 * Type definitions for Conet API
 */

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
  price_breakdown?: {
    base_compute_usd_hour: number;
    network_uplift_usd_hour: number;
    reliability_uplift_usd_hour: number;
    diversity_discount_usd_hour: number;
    redundancy_overhead_usd_hour: number;
    platform_fee_usd_hour: number;
    payout_pool_usd_hour: number;
    total_usd_hour: number;
  };
  members: ClusterMember[];
}

export interface ClusterMember {
  device_class: string;
  h100_equivalent: number;
  weight: number;
  reliability_score: number;
  trust_score: number;
}

export interface Job {
  id: string;
  handle: string;
  enterprise_id: string;
  kind: string;
  status: 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';
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
  input_manifest: Record<string, any>;
  output_manifest: Record<string, any>;
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
  hashcrack_range?: {
    algorithm: string;
    target_hash: string;
    salt?: string;
    charset: string;
    min_length: number;
    max_length: number;
    chunk_size?: number;
  };
  hashcrack_dict?: Record<string, any>;
  fhe_share?: Record<string, any>;
  raw_manifest?: Record<string, any>;
  isolation_policy?: Record<string, any>;
  callback_url?: string;
}

export interface ApiKey {
  id: string;
  label: string;
  key_prefix: string;
  scopes: string[];
  last_used_at?: string;
  revoked_at?: string;
  expires_at?: string;
  is_active: boolean;
}

export interface ApiKeyCreated extends ApiKey {
  api_key: string;
}

export interface ApiKeyCreatePayload {
  label: string;
  scopes?: string[];
  expires_in_days?: number;
}

export interface ListOptions {
  limit?: number;
  status?: string;
}
