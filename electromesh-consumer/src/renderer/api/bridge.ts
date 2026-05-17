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

export interface AgentStatus {
  running: boolean;
  deviceId: string | null;
  attested: boolean;
  inflight: number;
  capacity: number;
  lastHeartbeatAt: string | null;
  lastClaimAt: string | null;
  lastError: string | null;
  units: Array<{
    workunit_id: string;
    progress_pct: number;
    scanned?: number;
    started_at: string;
  }>;
}

export interface DashboardSnapshot {
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
}

export const bridge = window.electromesh;
