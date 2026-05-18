"""Enterprise API key scopes and authorization.

Two-tier key model:
- ``access`` keys (em_live_…) — control-plane access; manage account, list
  clusters, purchase clusters, manage other keys. Allowed scopes are the
  ones in :data:`ACCESS_SCOPES`.
- ``cluster`` keys (em_cluster_…) — data-plane access; submit workloads to
  the one cluster they were purchased for. Allowed scopes are the ones in
  :data:`CLUSTER_SCOPES` and are auto-attached at issuance time.
"""

from __future__ import annotations

ENTERPRISE_SCOPES = {
    # ── access-key scopes ────────────────────────────────────────────────
    "clusters:read": {
        "kind": "access",
        "description": "List and view cluster details",
        "applies_to": [
            "GET /v1/clusters",
            "GET /v1/clusters/{id}",
            "POST /v1/marketplace/search",
            "POST /v1/marketplace/quote",
        ],
    },
    "clusters:purchase": {
        "kind": "access",
        "description": "Purchase a cluster lease and mint a cluster key",
        "applies_to": [
            "POST /v1/enterprise/clusters/{id}/purchase",
        ],
    },
    "clusters:submit_job": {
        # Submit a "regular" job that auto-leases clusters (the legacy flow).
        # Cluster-bound workloads should use a cluster key + /v1/compute/run.
        "kind": "access",
        "description": "Submit compute jobs that auto-lease clusters",
        "applies_to": ["POST /v1/jobs"],
    },
    "clusters:manage_keys": {
        "kind": "access",
        "description": "Create, revoke, and list API keys (access + cluster)",
        "applies_to": [
            "POST /v1/enterprise/me/api-keys",
            "GET /v1/enterprise/me/api-keys",
            "DELETE /v1/enterprise/me/api-keys/{id}",
            "GET /v1/enterprise/me/cluster-keys",
            "DELETE /v1/enterprise/me/cluster-keys/{id}",
        ],
    },
    "jobs:read": {
        "kind": "access",
        "description": "List and view job details",
        "applies_to": [
            "GET /v1/jobs",
            "GET /v1/jobs/{id}",
            "GET /v1/jobs/{id}/workunits",
        ],
    },
    # ── cluster-key scopes ───────────────────────────────────────────────
    "compute:run": {
        "kind": "cluster",
        "description": "Submit and poll workloads against the bound cluster",
        "applies_to": [
            "POST /v1/compute/run",
            "GET /v1/compute/runs/{id}",
            "POST /v1/compute/runs/{id}/cancel",
        ],
    },
}

ACCESS_SCOPES: list[str] = sorted(
    s for s, meta in ENTERPRISE_SCOPES.items() if meta.get("kind") == "access"
)
CLUSTER_SCOPES: list[str] = sorted(
    s for s, meta in ENTERPRISE_SCOPES.items() if meta.get("kind") == "cluster"
)

# Default scopes given to a fresh access key (sane minimum for the operator
# console to function).
DEFAULT_ACCESS_SCOPES: list[str] = [
    "clusters:read",
    "clusters:submit_job",
    "jobs:read",
]
DEFAULT_CLUSTER_SCOPES: list[str] = ["compute:run"]


def validate_scopes(requested: list[str], *, key_kind: str = "access") -> bool:
    """Check that all requested scopes exist *and* belong to ``key_kind``."""
    allowed = ACCESS_SCOPES if key_kind == "access" else CLUSTER_SCOPES
    return all(s in allowed for s in requested)


def get_scope_description(scope: str) -> str:
    """Get human-readable description for a scope."""
    return ENTERPRISE_SCOPES.get(scope, {}).get("description", "Unknown scope")
