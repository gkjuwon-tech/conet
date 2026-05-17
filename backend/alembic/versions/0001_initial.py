"""initial schema

Revision ID: 0001_initial
Revises:
Create Date: 2026-05-08
"""
from __future__ import annotations

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

revision: str = "0001_initial"
down_revision: Union[str, None] = None
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    user_status = postgresql.ENUM(
        "pending",
        "active",
        "suspended",
        "banned",
        "closed",
        name="user_status",
        create_type=False,
    )
    user_status.create(op.get_bind(), checkfirst=True)

    op.create_table(
        "users",
        sa.Column("id", sa.String(40), primary_key=True),
        sa.Column("email", sa.String(255), nullable=False, unique=True),
        sa.Column("display_name", sa.String(120)),
        sa.Column("password_hash", sa.String(255), nullable=False),
        sa.Column("status", user_status, nullable=False),
        sa.Column("country_code", sa.String(2)),
        sa.Column("timezone", sa.String(64)),
        sa.Column("locale", sa.String(16), nullable=False, server_default="en-US"),
        sa.Column("payout_method", sa.String(40)),
        sa.Column("stripe_account_id", sa.String(64)),
        sa.Column("accepted_tos_at", sa.DateTime(timezone=True)),
        sa.Column("accepted_tos_version", sa.String(16)),
        sa.Column("email_verified", sa.Boolean, nullable=False, server_default=sa.text("false")),
        sa.Column("two_factor_enabled", sa.Boolean, nullable=False, server_default=sa.text("false")),
        sa.Column("two_factor_secret", sa.String(64)),
        sa.Column("referral_code", sa.String(16), unique=True),
        sa.Column("referred_by", sa.String(40)),
        sa.Column("settings", postgresql.JSONB, nullable=False, server_default=sa.text("'{}'::jsonb")),
        sa.Column("metadata", postgresql.JSONB, nullable=False, server_default=sa.text("'{}'::jsonb")),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
    )
    op.create_index("ix_users_status", "users", ["status"])
    op.create_index("ix_users_country", "users", ["country_code"])

    op.execute(
        """
        CREATE TYPE device_class AS ENUM (
            'smart_bulb','smart_plug','smart_tv','fridge','washer','dryer','microwave',
            'router','nas','desktop','laptop','console','phone','tablet','gpu_rig','other_iot'
        );
        CREATE TYPE device_status AS ENUM (
            'pending_attestation','benchmarking','idle','leased','cooldown','offline','quarantined','decommissioned'
        );
        CREATE TYPE cluster_status AS ENUM (
            'forming','available','leased','draining','retired'
        );
        CREATE TYPE job_kind AS ENUM (
            'hashcrack.range','hashcrack.dict','fhe.share','mpc.share','ml.embed.public','render.tile'
        );
        CREATE TYPE job_status AS ENUM (
            'draft','queued','leasing','running','succeeded','failed','cancelled','timed_out','rejected'
        );
        CREATE TYPE workunit_status AS ENUM (
            'pending','dispatched','in_flight','succeeded','failed','timed_out','cancelled','consensus_pending','consensus_failed'
        );
        CREATE TYPE payout_status AS ENUM (
            'pending','processing','paid','failed','cancelled','held'
        );
        CREATE TYPE wallet_entry_kind AS ENUM (
            'earning','bonus','referral','adjustment','payout','fee','chargeback'
        );
        CREATE TYPE enterprise_status AS ENUM (
            'pending','active','paused','terminated'
        );
        """
    )

    op.create_table(
        "devices",
        sa.Column("id", sa.String(40), primary_key=True),
        sa.Column("handle", sa.String(64), nullable=False, unique=True),
        sa.Column("owner_id", sa.String(40), sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False),
        sa.Column("label", sa.String(120)),
        sa.Column("device_class", postgresql.ENUM(name="device_class", create_type=False), nullable=False),
        sa.Column("status", postgresql.ENUM(name="device_status", create_type=False), nullable=False),
        sa.Column("vendor", sa.String(80)),
        sa.Column("model", sa.String(120)),
        sa.Column("firmware", sa.String(80)),
        sa.Column("os", sa.String(40)),
        sa.Column("arch", sa.String(40)),
        sa.Column("cpu_cores", sa.Integer, nullable=False, server_default="0"),
        sa.Column("cpu_ghz", sa.Float, nullable=False, server_default="0"),
        sa.Column("ram_mb", sa.Integer, nullable=False, server_default="0"),
        sa.Column("storage_gb", sa.Integer, nullable=False, server_default="0"),
        sa.Column("gpu_model", sa.String(80)),
        sa.Column("gpu_vram_mb", sa.Integer, nullable=False, server_default="0"),
        sa.Column("cpu_gflops", sa.Float, nullable=False, server_default="0"),
        sa.Column("gpu_gflops", sa.Float, nullable=False, server_default="0"),
        sa.Column("hash_mhs_sha256", sa.Float, nullable=False, server_default="0"),
        sa.Column("hash_mhs_argon2", sa.Float, nullable=False, server_default="0"),
        sa.Column("network_mbps_down", sa.Float, nullable=False, server_default="0"),
        sa.Column("network_mbps_up", sa.Float, nullable=False, server_default="0"),
        sa.Column("network_latency_ms", sa.Float, nullable=False, server_default="0"),
        sa.Column("h100_equivalent", sa.Float, nullable=False, server_default="0"),
        sa.Column("reliability_score", sa.Float, nullable=False, server_default="0.5"),
        sa.Column("trust_score", sa.Float, nullable=False, server_default="0.5"),
        sa.Column("contribution_score", sa.Float, nullable=False, server_default="0"),
        sa.Column("avg_idle_hours_per_day", sa.Float, nullable=False, server_default="0"),
        sa.Column("last_seen_at", sa.DateTime(timezone=True)),
        sa.Column("last_benchmark_at", sa.DateTime(timezone=True)),
        sa.Column("public_key", sa.String(512)),
        sa.Column("attestation_proof", sa.String(2048)),
        sa.Column("attestation_verified_at", sa.DateTime(timezone=True)),
        sa.Column("lan_fingerprint", sa.String(64)),
        sa.Column("last_ip", postgresql.INET()),
        sa.Column("user_agent", sa.String(255)),
        sa.Column("revenue_cents_lifetime", sa.BigInteger, nullable=False, server_default="0"),
        sa.Column("workunits_completed", sa.BigInteger, nullable=False, server_default="0"),
        sa.Column("workunits_rejected", sa.BigInteger, nullable=False, server_default="0"),
        sa.Column("consents", postgresql.JSONB, nullable=False, server_default=sa.text("'{}'::jsonb")),
        sa.Column("capabilities", postgresql.JSONB, nullable=False, server_default=sa.text("'{}'::jsonb")),
        sa.Column("metadata", postgresql.JSONB, nullable=False, server_default=sa.text("'{}'::jsonb")),
        sa.Column("auto_join_enabled", sa.Boolean, nullable=False, server_default=sa.text("true")),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
    )
    op.create_index("ix_devices_owner", "devices", ["owner_id"])
    op.create_index("ix_devices_status_class", "devices", ["status", "device_class"])
    op.create_index("ix_devices_lan", "devices", ["lan_fingerprint"])
    op.create_index("ix_devices_h100eq", "devices", ["h100_equivalent"])

    op.create_table(
        "device_telemetry",
        sa.Column("id", sa.String(40), primary_key=True),
        sa.Column("device_id", sa.String(40), sa.ForeignKey("devices.id", ondelete="CASCADE"), nullable=False),
        sa.Column("sampled_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("cpu_usage_pct", sa.Float, nullable=False, server_default="0"),
        sa.Column("gpu_usage_pct", sa.Float, nullable=False, server_default="0"),
        sa.Column("ram_usage_pct", sa.Float, nullable=False, server_default="0"),
        sa.Column("temperature_c", sa.Float),
        sa.Column("power_watts", sa.Float),
        sa.Column("rssi_dbm", sa.Float),
        sa.Column("download_mbps", sa.Float),
        sa.Column("upload_mbps", sa.Float),
        sa.Column("extras", postgresql.JSONB, nullable=False, server_default=sa.text("'{}'::jsonb")),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
    )
    op.create_index("ix_telemetry_device_time", "device_telemetry", ["device_id", "sampled_at"])

    op.create_table(
        "clusters",
        sa.Column("id", sa.String(40), primary_key=True),
        sa.Column("handle", sa.String(64), nullable=False, unique=True),
        sa.Column("sequence_no", sa.BigInteger, nullable=False, unique=True),
        sa.Column("status", postgresql.ENUM(name="cluster_status", create_type=False), nullable=False),
        sa.Column("member_count", sa.Integer, nullable=False, server_default="0"),
        sa.Column("target_size", sa.Integer, nullable=False),
        sa.Column("aggregate_cpu_gflops", sa.Float, nullable=False, server_default="0"),
        sa.Column("aggregate_gpu_gflops", sa.Float, nullable=False, server_default="0"),
        sa.Column("aggregate_ram_mb", sa.BigInteger, nullable=False, server_default="0"),
        sa.Column("aggregate_vram_mb", sa.BigInteger, nullable=False, server_default="0"),
        sa.Column("aggregate_storage_gb", sa.BigInteger, nullable=False, server_default="0"),
        sa.Column("aggregate_hash_mhs_sha256", sa.Float, nullable=False, server_default="0"),
        sa.Column("aggregate_network_mbps", sa.Float, nullable=False, server_default="0"),
        sa.Column("h100_equivalent", sa.Float, nullable=False, server_default="0"),
        sa.Column("reliability_score", sa.Float, nullable=False, server_default="0"),
        sa.Column("trust_score", sa.Float, nullable=False, server_default="0"),
        sa.Column("diversity_index", sa.Float, nullable=False, server_default="0"),
        sa.Column("price_usd_per_hour", sa.Float, nullable=False, server_default="0"),
        sa.Column("price_breakdown", postgresql.JSONB, nullable=False, server_default=sa.text("'{}'::jsonb")),
        sa.Column("capability_summary", postgresql.JSONB, nullable=False, server_default=sa.text("'{}'::jsonb")),
        sa.Column("composition", postgresql.JSONB, nullable=False, server_default=sa.text("'{}'::jsonb")),
        sa.Column("formed_at", sa.DateTime(timezone=True)),
        sa.Column("available_at", sa.DateTime(timezone=True)),
        sa.Column("leased_at", sa.DateTime(timezone=True)),
        sa.Column("retired_at", sa.DateTime(timezone=True)),
        sa.Column("is_listed", sa.Boolean, nullable=False, server_default=sa.text("true")),
        sa.Column("region_hint", sa.String(32)),
        sa.Column("metadata", postgresql.JSONB, nullable=False, server_default=sa.text("'{}'::jsonb")),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
    )
    op.create_index("ix_clusters_status_listed", "clusters", ["status", "is_listed"])
    op.create_index("ix_clusters_h100eq", "clusters", ["h100_equivalent"])
    op.create_index("ix_clusters_seq", "clusters", ["sequence_no"])

    op.create_table(
        "cluster_memberships",
        sa.Column("id", sa.String(40), primary_key=True),
        sa.Column("cluster_id", sa.String(40), sa.ForeignKey("clusters.id", ondelete="CASCADE"), nullable=False),
        sa.Column("device_id", sa.String(40), sa.ForeignKey("devices.id", ondelete="RESTRICT"), nullable=False),
        sa.Column("weight", sa.Float, nullable=False, server_default="1.0"),
        sa.Column("joined_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("left_at", sa.DateTime(timezone=True)),
        sa.Column("is_active", sa.Boolean, nullable=False, server_default=sa.text("true")),
        sa.Column("role", sa.String(24), nullable=False, server_default="worker"),
        sa.Column("snapshot", postgresql.JSONB, nullable=False, server_default=sa.text("'{}'::jsonb")),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.UniqueConstraint("cluster_id", "device_id", name="uq_membership_pair"),
    )
    op.create_index("ix_memberships_active", "cluster_memberships", ["cluster_id", "is_active"])

    op.create_table(
        "enterprises",
        sa.Column("id", sa.String(40), primary_key=True),
        sa.Column("name", sa.String(160), nullable=False),
        sa.Column("slug", sa.String(64), nullable=False, unique=True),
        sa.Column("status", postgresql.ENUM(name="enterprise_status", create_type=False), nullable=False),
        sa.Column("contact_email", sa.String(255), nullable=False),
        sa.Column("billing_email", sa.String(255)),
        sa.Column("tax_id", sa.String(64)),
        sa.Column("stripe_customer_id", sa.String(64)),
        sa.Column("credit_balance_cents", sa.BigInteger, nullable=False, server_default="0"),
        sa.Column("monthly_spend_cents", sa.BigInteger, nullable=False, server_default="0"),
        sa.Column("spend_cap_cents", sa.BigInteger),
        sa.Column("allowed_workload_kinds", postgresql.JSONB, nullable=False, server_default=sa.text("'[]'::jsonb")),
        sa.Column("compliance_tier", sa.String(24), nullable=False, server_default="standard"),
        sa.Column("sso_provider", sa.String(40)),
        sa.Column("sso_metadata", postgresql.JSONB, nullable=False, server_default=sa.text("'{}'::jsonb")),
        sa.Column("metadata", postgresql.JSONB, nullable=False, server_default=sa.text("'{}'::jsonb")),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
    )
    op.create_index("ix_enterprises_status", "enterprises", ["status"])

    op.create_table(
        "enterprise_api_keys",
        sa.Column("id", sa.String(40), primary_key=True),
        sa.Column("enterprise_id", sa.String(40), sa.ForeignKey("enterprises.id", ondelete="CASCADE"), nullable=False),
        sa.Column("label", sa.String(120), nullable=False),
        sa.Column("key_prefix", sa.String(16), nullable=False),
        sa.Column("key_hash", sa.String(255), nullable=False),
        sa.Column("scopes", postgresql.JSONB, nullable=False, server_default=sa.text("'[]'::jsonb")),
        sa.Column("last_used_at", sa.DateTime(timezone=True)),
        sa.Column("revoked_at", sa.DateTime(timezone=True)),
        sa.Column("expires_at", sa.DateTime(timezone=True)),
        sa.Column("is_active", sa.Boolean, nullable=False, server_default=sa.text("true")),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
    )
    op.create_index("ix_enterprise_keys_prefix", "enterprise_api_keys", ["key_prefix"])

    op.create_table(
        "jobs",
        sa.Column("id", sa.String(40), primary_key=True),
        sa.Column("handle", sa.String(64), nullable=False, unique=True),
        sa.Column("enterprise_id", sa.String(40), sa.ForeignKey("enterprises.id", ondelete="RESTRICT"), nullable=False),
        sa.Column("kind", postgresql.ENUM(name="job_kind", create_type=False), nullable=False),
        sa.Column("status", postgresql.ENUM(name="job_status", create_type=False), nullable=False),
        sa.Column("title", sa.String(160)),
        sa.Column("description", sa.String(2000)),
        sa.Column("input_manifest", postgresql.JSONB, nullable=False, server_default=sa.text("'{}'::jsonb")),
        sa.Column("output_manifest", postgresql.JSONB, nullable=False, server_default=sa.text("'{}'::jsonb")),
        sa.Column("isolation_policy", postgresql.JSONB, nullable=False, server_default=sa.text("'{}'::jsonb")),
        sa.Column("target_cluster_count", sa.Integer, nullable=False, server_default="1"),
        sa.Column("target_h100_equivalent", sa.Float, nullable=False, server_default="0"),
        sa.Column("max_budget_cents", sa.BigInteger, nullable=False, server_default="0"),
        sa.Column("max_runtime_seconds", sa.Integer, nullable=False, server_default="3600"),
        sa.Column("redundancy", sa.Integer, nullable=False, server_default="2"),
        sa.Column("consensus_threshold", sa.Float, nullable=False, server_default="0.66"),
        sa.Column("workunit_total", sa.BigInteger, nullable=False, server_default="0"),
        sa.Column("workunit_completed", sa.BigInteger, nullable=False, server_default="0"),
        sa.Column("workunit_failed", sa.BigInteger, nullable=False, server_default="0"),
        sa.Column("spent_cents", sa.BigInteger, nullable=False, server_default="0"),
        sa.Column("paid_to_users_cents", sa.BigInteger, nullable=False, server_default="0"),
        sa.Column("platform_fee_cents", sa.BigInteger, nullable=False, server_default="0"),
        sa.Column("submitted_at", sa.DateTime(timezone=True)),
        sa.Column("started_at", sa.DateTime(timezone=True)),
        sa.Column("finished_at", sa.DateTime(timezone=True)),
        sa.Column("deadline_at", sa.DateTime(timezone=True)),
        sa.Column("callback_url", sa.String(2048)),
        sa.Column("callback_secret", sa.String(255)),
        sa.Column("callback_delivered", sa.Boolean, nullable=False, server_default=sa.text("false")),
        sa.Column("metadata", postgresql.JSONB, nullable=False, server_default=sa.text("'{}'::jsonb")),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
    )
    op.create_index("ix_jobs_enterprise_status", "jobs", ["enterprise_id", "status"])
    op.create_index("ix_jobs_kind_status", "jobs", ["kind", "status"])

    op.create_table(
        "cluster_leases",
        sa.Column("id", sa.String(40), primary_key=True),
        sa.Column("cluster_id", sa.String(40), sa.ForeignKey("clusters.id", ondelete="RESTRICT"), nullable=False),
        sa.Column("job_id", sa.String(40), sa.ForeignKey("jobs.id", ondelete="CASCADE"), nullable=False),
        sa.Column("started_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("ended_at", sa.DateTime(timezone=True)),
        sa.Column("expected_end_at", sa.DateTime(timezone=True)),
        sa.Column("rate_usd_per_hour", sa.Float, nullable=False),
        sa.Column("runtime_seconds", sa.BigInteger, nullable=False, server_default="0"),
        sa.Column("billed_cents", sa.BigInteger, nullable=False, server_default="0"),
        sa.Column("is_open", sa.Boolean, nullable=False, server_default=sa.text("true")),
        sa.Column("metadata", postgresql.JSONB, nullable=False, server_default=sa.text("'{}'::jsonb")),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
    )
    op.create_index("ix_leases_open", "cluster_leases", ["is_open"])
    op.create_index("ix_leases_job", "cluster_leases", ["job_id"])
    op.create_index("ix_leases_cluster_open", "cluster_leases", ["cluster_id", "is_open"])

    op.create_table(
        "workunits",
        sa.Column("id", sa.String(40), primary_key=True),
        sa.Column("handle", sa.String(64), nullable=False, unique=True),
        sa.Column("job_id", sa.String(40), sa.ForeignKey("jobs.id", ondelete="CASCADE"), nullable=False),
        sa.Column("sequence_no", sa.BigInteger, nullable=False),
        sa.Column("status", postgresql.ENUM(name="workunit_status", create_type=False), nullable=False),
        sa.Column("payload", postgresql.JSONB, nullable=False, server_default=sa.text("'{}'::jsonb")),
        sa.Column("payload_hash", sa.String(64), nullable=False),
        sa.Column("expected_runtime_seconds", sa.Integer, nullable=False, server_default="60"),
        sa.Column("weight", sa.Float, nullable=False, server_default="1.0"),
        sa.Column("redundancy_required", sa.Integer, nullable=False, server_default="2"),
        sa.Column("redundancy_satisfied", sa.Integer, nullable=False, server_default="0"),
        sa.Column("final_result", postgresql.JSONB),
        sa.Column("final_result_hash", sa.String(64)),
        sa.Column("consensus_score", sa.Float),
        sa.Column("dispatched_at", sa.DateTime(timezone=True)),
        sa.Column("completed_at", sa.DateTime(timezone=True)),
        sa.Column("deadline_at", sa.DateTime(timezone=True)),
        sa.Column("metadata", postgresql.JSONB, nullable=False, server_default=sa.text("'{}'::jsonb")),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
    )
    op.create_index("ix_workunits_job_status", "workunits", ["job_id", "status"])
    op.create_index("ix_workunits_status_deadline", "workunits", ["status", "deadline_at"])

    op.create_table(
        "workunit_attempts",
        sa.Column("id", sa.String(40), primary_key=True),
        sa.Column("workunit_id", sa.String(40), sa.ForeignKey("workunits.id", ondelete="CASCADE"), nullable=False),
        sa.Column("device_id", sa.String(40), sa.ForeignKey("devices.id", ondelete="RESTRICT"), nullable=False),
        sa.Column("attempt_no", sa.Integer, nullable=False, server_default="1"),
        sa.Column("status", postgresql.ENUM(name="workunit_status", create_type=False), nullable=False),
        sa.Column("started_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("completed_at", sa.DateTime(timezone=True)),
        sa.Column("runtime_ms", sa.BigInteger),
        sa.Column("result", postgresql.JSONB),
        sa.Column("result_hash", sa.String(64)),
        sa.Column("proof", sa.String(2048)),
        sa.Column("error_code", sa.String(64)),
        sa.Column("error_message", sa.String(1024)),
        sa.Column("accepted", sa.Boolean, nullable=False, server_default=sa.text("false")),
        sa.Column("rewarded_cents", sa.BigInteger, nullable=False, server_default="0"),
        sa.Column("metadata", postgresql.JSONB, nullable=False, server_default=sa.text("'{}'::jsonb")),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
    )
    op.create_index("ix_attempts_device_status", "workunit_attempts", ["device_id", "status"])
    op.create_index("ix_attempts_workunit", "workunit_attempts", ["workunit_id"])

    op.create_table(
        "wallets",
        sa.Column("id", sa.String(40), primary_key=True),
        sa.Column("user_id", sa.String(40), sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False, unique=True),
        sa.Column("available_cents", sa.BigInteger, nullable=False, server_default="0"),
        sa.Column("pending_cents", sa.BigInteger, nullable=False, server_default="0"),
        sa.Column("held_cents", sa.BigInteger, nullable=False, server_default="0"),
        sa.Column("lifetime_earned_cents", sa.BigInteger, nullable=False, server_default="0"),
        sa.Column("lifetime_paid_cents", sa.BigInteger, nullable=False, server_default="0"),
        sa.Column("last_activity_at", sa.DateTime(timezone=True)),
        sa.Column("metadata", postgresql.JSONB, nullable=False, server_default=sa.text("'{}'::jsonb")),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
    )

    op.create_table(
        "wallet_entries",
        sa.Column("id", sa.String(40), primary_key=True),
        sa.Column("wallet_id", sa.String(40), sa.ForeignKey("wallets.id", ondelete="CASCADE"), nullable=False),
        sa.Column("kind", postgresql.ENUM(name="wallet_entry_kind", create_type=False), nullable=False),
        sa.Column("amount_cents", sa.BigInteger, nullable=False),
        sa.Column("balance_after_cents", sa.BigInteger, nullable=False),
        sa.Column("occurred_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("reference_type", sa.String(40)),
        sa.Column("reference_id", sa.String(64)),
        sa.Column("description", sa.String(512)),
        sa.Column("metadata", postgresql.JSONB, nullable=False, server_default=sa.text("'{}'::jsonb")),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
    )
    op.create_index("ix_wallet_entries_wallet_time", "wallet_entries", ["wallet_id", "occurred_at"])
    op.create_index("ix_wallet_entries_kind", "wallet_entries", ["kind"])

    op.create_table(
        "payouts",
        sa.Column("id", sa.String(40), primary_key=True),
        sa.Column("handle", sa.String(64), nullable=False, unique=True),
        sa.Column("user_id", sa.String(40), sa.ForeignKey("users.id", ondelete="RESTRICT"), nullable=False),
        sa.Column("amount_cents", sa.BigInteger, nullable=False),
        sa.Column("currency", sa.String(3), nullable=False, server_default="USD"),
        sa.Column("status", postgresql.ENUM(name="payout_status", create_type=False), nullable=False),
        sa.Column("period_start", sa.DateTime(timezone=True), nullable=False),
        sa.Column("period_end", sa.DateTime(timezone=True), nullable=False),
        sa.Column("method", sa.String(40), nullable=False, server_default="stripe"),
        sa.Column("external_id", sa.String(128)),
        sa.Column("failure_reason", sa.String(512)),
        sa.Column("initiated_at", sa.DateTime(timezone=True)),
        sa.Column("settled_at", sa.DateTime(timezone=True)),
        sa.Column("metadata", postgresql.JSONB, nullable=False, server_default=sa.text("'{}'::jsonb")),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
    )
    op.create_index("ix_payouts_user_status", "payouts", ["user_id", "status"])
    op.create_index("ix_payouts_period", "payouts", ["period_start", "period_end"])

    op.create_table(
        "payout_ledger_entries",
        sa.Column("id", sa.String(40), primary_key=True),
        sa.Column("payout_id", sa.String(40), sa.ForeignKey("payouts.id", ondelete="SET NULL")),
        sa.Column("user_id", sa.String(40), sa.ForeignKey("users.id", ondelete="RESTRICT"), nullable=False),
        sa.Column("device_id", sa.String(40), sa.ForeignKey("devices.id", ondelete="SET NULL")),
        sa.Column("workunit_id", sa.String(40), sa.ForeignKey("workunits.id", ondelete="SET NULL")),
        sa.Column("job_id", sa.String(40), sa.ForeignKey("jobs.id", ondelete="SET NULL")),
        sa.Column("amount_cents", sa.BigInteger, nullable=False),
        sa.Column("weight", sa.BigInteger, nullable=False, server_default="0"),
        sa.Column("occurred_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("is_finalized", sa.Boolean, nullable=False, server_default=sa.text("false")),
        sa.Column("note", sa.String(512)),
        sa.Column("metadata", postgresql.JSONB, nullable=False, server_default=sa.text("'{}'::jsonb")),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
    )
    op.create_index("ix_ledger_user_time", "payout_ledger_entries", ["user_id", "occurred_at"])
    op.create_index("ix_ledger_payout", "payout_ledger_entries", ["payout_id"])
    op.create_index("ix_ledger_device", "payout_ledger_entries", ["device_id"])

    op.create_table(
        "audit_events",
        sa.Column("id", sa.String(40), primary_key=True),
        sa.Column("occurred_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("actor_kind", sa.String(24), nullable=False),
        sa.Column("actor_id", sa.String(40)),
        sa.Column("actor_label", sa.String(160)),
        sa.Column("event_type", sa.String(80), nullable=False),
        sa.Column("target_kind", sa.String(40)),
        sa.Column("target_id", sa.String(64)),
        sa.Column("ip", postgresql.INET()),
        sa.Column("user_agent", sa.String(255)),
        sa.Column("severity", sa.String(16), nullable=False, server_default="info"),
        sa.Column("payload", postgresql.JSONB, nullable=False, server_default=sa.text("'{}'::jsonb")),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
    )
    op.create_index("ix_audit_actor", "audit_events", ["actor_kind", "actor_id"])
    op.create_index("ix_audit_event_time", "audit_events", ["event_type", "occurred_at"])
    op.create_index("ix_audit_target", "audit_events", ["target_kind", "target_id"])


def downgrade() -> None:
    for table in (
        "audit_events",
        "payout_ledger_entries",
        "payouts",
        "wallet_entries",
        "wallets",
        "workunit_attempts",
        "workunits",
        "cluster_leases",
        "jobs",
        "enterprise_api_keys",
        "enterprises",
        "cluster_memberships",
        "clusters",
        "device_telemetry",
        "devices",
        "users",
    ):
        op.drop_table(table)

    for typename in (
        "wallet_entry_kind",
        "payout_status",
        "workunit_status",
        "job_status",
        "job_kind",
        "cluster_status",
        "device_status",
        "device_class",
        "enterprise_status",
        "user_status",
    ):
        op.execute(f"DROP TYPE IF EXISTS {typename}")
