"""First-run bootstrap.

Creates a `demo` enterprise tenant with an admin-scoped API key the CLI can
use to drive the rest of the system. Idempotent — if the enterprise already
exists this script is a no-op.

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

from app.auth.passwords import generate_api_key
from app.db.models.enterprise import Enterprise, EnterpriseApiKey, EnterpriseStatus
from app.db.session import sync_session_scope
from app.utils.ids import new_ulid


SLUG = os.environ.get("EM_BOOTSTRAP_SLUG", "demo")
NAME = os.environ.get("EM_BOOTSTRAP_NAME", "ElectroMesh Demo Tenant")
EMAIL = os.environ.get("EM_BOOTSTRAP_EMAIL", "demo@electromesh.local")
KEY_LABEL = os.environ.get("EM_BOOTSTRAP_KEY_LABEL", "bootstrap-admin")
SCOPES = [
    "admin.*",
    "jobs.submit",
    "jobs.read",
    "jobs.cancel",
    "marketplace.read"
]
WRITE_PATH = Path(os.environ.get("EM_BOOTSTRAP_OUT", "/app/.bootstrap.json"))


def main() -> int:
    with sync_session_scope() as session:
        existing = session.execute(
            select(Enterprise).where(Enterprise.slug == SLUG)
        ).scalar_one_or_none()

        if existing is not None:
            print(f"[bootstrap] enterprise '{SLUG}' already exists ({existing.id}); leaving keys intact.")
            return 0

        enterprise = Enterprise(
            id=new_ulid(),
            name=NAME,
            slug=SLUG,
            status=EnterpriseStatus.active,
            contact_email=EMAIL,
            allowed_workload_kinds=[
                "hashcrack.range",
                "hashcrack.dict",
                "fhe.share",
                "mpc.share"
            ],
            compliance_tier="standard"
        )
        session.add(enterprise)
        session.flush()

        full, prefix, hashed = generate_api_key()
        api_key = EnterpriseApiKey(
            id=new_ulid(),
            enterprise_id=enterprise.id,
            label=KEY_LABEL,
            key_prefix=prefix,
            key_hash=hashed,
            scopes=SCOPES,
            is_active=True
        )
        try:
            session.add(api_key)
            session.flush()
        except IntegrityError as e:
            print(f"[bootstrap] failed to insert api key: {e}", file=sys.stderr)
            return 1

        payload = {
            "enterprise_id": enterprise.id,
            "enterprise_slug": enterprise.slug,
            "enterprise_name": enterprise.name,
            "api_key": full,
            "api_key_prefix": prefix,
            "scopes": SCOPES
        }

        try:
            WRITE_PATH.write_text(json.dumps(payload, indent=2))
            print(f"[bootstrap] credentials written to {WRITE_PATH}")
        except OSError as e:
            print(f"[bootstrap] could not write {WRITE_PATH}: {e}", file=sys.stderr)

        print("=" * 70)
        print("[bootstrap] DEMO ENTERPRISE PROVISIONED")
        print(f"  slug        : {enterprise.slug}")
        print(f"  enterprise  : {enterprise.id}")
        print(f"  api_key     : {full}")
        print(f"  scopes      : {', '.join(SCOPES)}")
        print("=" * 70)
        print("Copy the api_key above; it will not be shown again.")
        return 0


if __name__ == "__main__":
    raise SystemExit(main())
