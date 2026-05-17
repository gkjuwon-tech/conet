export const bridge = window.electromesh;

export interface Enterprise {
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
}

export interface Stats {
  jobs_active: number;
  jobs_completed_30d: number;
  spend_30d_cents: number;
  avg_runtime_seconds_30d: number;
  success_rate_30d: number;
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
