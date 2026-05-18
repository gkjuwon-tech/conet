"""First-run bootstrap.

Creates a `demo` enterprise tenant with:
  1. An **access** API key (``em_live_…``) for the operator console / CLI.
  2. An **example cluster** and a **cluster** API key (``em_cluster_…``) bound
     to it so SDK consumers have something to hit immediately. The cluster
     has no real devices attached; it exists purely so ``compute.run``
     authenticates end-to-end against the local stack.

Idempotent — if the enterprise already exists, the script is a no-op.

Usage:
    python -m scripts.bootstrap
"""
from __future__ import annotations

import json
import os
import sys
from pathlib import Path

from sqlalchemy import select
from sqlalchemy.exc import IntegrityError

from app.auth.enterprise_scopes import (
    DEFAULT_ACCESS_SCOPES,
    DEFAULT_CLUSTER_SCOPES,
)
from app.auth.passwords import generate_api_key
from app.db.models.cluster import Cluster, ClusterStatus
from app.db.models.enterprise import (
    Enterprise,
    EnterpriseApiKey,
    EnterpriseApiKeyKind,
    EnterpriseStatus,
)
from app.db.session import sync_session_scope
from app.utils.ids import cluster_handle, new_ulid
from app.utils.time import utcnow


SLUG = os.environ.get("EM_BOOTSTRAP_SLUG", "demo")
NAME = os.environ.get("EM_BOOTSTRAP_NAME", "ElectroMesh Demo Tenant")
EMAIL = os.environ.get("EM_BOOTSTRAP_EMAIL", "demo@electromesh.local")
KEY_LABEL = os.environ.get("EM_BOOTSTRAP_KEY_LABEL", "bootstrap-admin")
CLUSTER_KEY_LABEL = os.environ.get(
    "EM_BOOTSTRAP_CLUSTER_KEY_LABEL", "bootstrap-demo-cluster"
)
ACCESS_SCOPES = ["admin.*", *DEFAULT_ACCESS_SCOPES, "clusters:purchase", "clusters:manage_keys"]
CLUSTER_SCOPES = list(DEFAULT_CLUSTER_SCOPES)
CLUSTER_BUDGET_CENTS = int(os.environ.get("EM_BOOTSTRAP_CLUSTER_BUDGET_CENTS", "50000"))
WRITE_PATH = Path(os.environ.get("EM_BOOTSTRAP_OUT", "/app/.bootstrap.json"))


def _next_cluster_seq(session) -> int:
    """Pick the next free Cluster.sequence_no \u2014 dumb but deterministic."""
    from sqlalchemy import func as sa_func

    val = session.execute(
        select(sa_func.coalesce(sa_func.max(Cluster.sequence_no), 0))
    ).scalar_one() or 0
    return int(val) + 1


def main() -> int:
    with sync_session_scope() as session:
        existing = session.execute(
            select(Enterprise).where(Enterprise.slug == SLUG)
        ).scalar_one_or_none()

        if existing is not None:
            print(
                f"[bootstrap] enterprise '{SLUG}' already exists ({existing.id}); "
                "leaving keys intact."
            )
            return 0

        enterprise = Enterprise(
            id=new_ulid(),
            name=NAME,
            slug=SLUG,
            status=EnterpriseStatus.active,
            contact_email=EMAIL,
            credit_balance_cents=1_000_000,  # $10k headroom for demos
            allowed_workload_kinds=[
                "hashcrack.range",
                "hashcrack.dict",
                "fhe.share",
                "mpc.share",
                "compute.shell",
            ],
            compliance_tier="standard",
        )
        session.add(enterprise)
        session.flush()

        # 1) Access key — control-plane access.
        access_full, access_prefix, access_hashed = generate_api_key(prefix="em_live")
        access_key = EnterpriseApiKey(
            id=new_ulid(),
            enterprise_id=enterprise.id,
            label=KEY_LABEL,
            key_prefix=access_prefix,
            key_hash=access_hashed,
            scopes=ACCESS_SCOPES,
            kind=EnterpriseApiKeyKind.access,
            is_active=True,
        )
        try:
            session.add(access_key)
            session.flush()
        except IntegrityError as e:
            print(f"[bootstrap] failed to insert access api key: {e}", file=sys.stderr)
            return 1

        # 2) Example cluster — sized for "ergonomic demo" rather than realism.
        cluster = Cluster(
            id=new_ulid(),
            handle=cluster_handle(),
            sequence_no=_next_cluster_seq(session),
            status=ClusterStatus.leased,
            member_count=0,
            target_size=1,
            aggregate_cpu_gflops=2400.0,
            aggregate_gpu_gflops=58000.0,
            aggregate_ram_mb=131_072,
            aggregate_vram_mb=80_000,
            aggregate_storage_gb=1000,
            aggregate_hash_mhs_sha256=4500.0,
            aggregate_network_mbps=10_000.0,
            h100_equivalent=1.0,
            reliability_score=0.95,
            trust_score=0.92,
            diversity_index=0.5,
            price_usd_per_hour=2.50,
            price_breakdown={"base_per_hour_usd": 2.5, "fees_per_hour_usd": 0.0},
            capability_summary={"gpu": "h100-class", "vram_gb": 80, "storage_gb": 1000},
            composition={"devices": []},
            formed_at=utcnow(),
            available_at=utcnow(),
            leased_at=utcnow(),
            is_listed=True,
            region_hint="local",
            metadata_={"is_bootstrap_demo": True},
        )
        session.add(cluster)
        session.flush()

        # 3) Cluster key — bound to that cluster.
        cluster_full, cluster_prefix, cluster_hashed = generate_api_key(prefix="em_cluster")
        cluster_key = EnterpriseApiKey(
            id=new_ulid(),
            enterprise_id=enterprise.id,
            label=CLUSTER_KEY_LABEL,
            key_prefix=cluster_prefix,
            key_hash=cluster_hashed,
            scopes=CLUSTER_SCOPES,
            kind=EnterpriseApiKeyKind.cluster,
            bound_cluster_id=cluster.id,
            max_budget_cents=CLUSTER_BUDGET_CENTS,
            spent_cents=0,
            is_active=True,
        )
        try:
            session.add(cluster_key)
            session.flush()
        except IntegrityError as e:
            print(f"[bootstrap] failed to insert cluster api key: {e}", file=sys.stderr)
            return 1

        # Reflect the reservation on the cluster.
        cluster.metadata_ = {
            **cluster.metadata_,
            "reserved_by_enterprise_id": enterprise.id,
            "reserved_by_key_id": cluster_key.id,
        }
        enterprise.credit_balance_cents -= CLUSTER_BUDGET_CENTS

        payload = {
            "enterprise_id": enterprise.id,
            "enterprise_slug": enterprise.slug,
            "enterprise_name": enterprise.name,
            "access_key": access_full,
            "access_key_prefix": access_prefix,
            "access_scopes": ACCESS_SCOPES,
            "cluster_id": cluster.id,
            "cluster_handle": cluster.handle,
            "cluster_key": cluster_full,
            "cluster_key_prefix": cluster_prefix,
            "cluster_scopes": CLUSTER_SCOPES,
            "cluster_budget_cents": CLUSTER_BUDGET_CENTS,
        }

        try:
            WRITE_PATH.write_text(json.dumps(payload, indent=2))
            print(f"[bootstrap] credentials written to {WRITE_PATH}")
        except OSError as e:
            print(f"[bootstrap] could not write {WRITE_PATH}: {e}", file=sys.stderr)

        print("=" * 70)
        print("[bootstrap] DEMO ENTERPRISE PROVISIONED")
        print(f"  slug         : {enterprise.slug}")
        print(f"  enterprise   : {enterprise.id}")
        print()
        print("  -- access key (control-plane / CLI) --")
        print(f"  access_key   : {access_full}")
        print(f"  scopes       : {', '.join(ACCESS_SCOPES)}")
        print()
        print("  -- cluster key (SDK / compute.run) --")
        print(f"  cluster_id   : {cluster.id}")
        print(f"  cluster_key  : {cluster_full}")
        print(f"  budget_cents : {CLUSTER_BUDGET_CENTS}")
        print(f"  scopes       : {', '.join(CLUSTER_SCOPES)}")
        print("=" * 70)
        print("Copy the keys above; they will not be shown again.")
        return 0


if __name__ == "__main__":
    raise SystemExit(main())
