"""Enterprise API key scopes and authorization."""

from __future__ import annotations

ENTERPRISE_SCOPES = {
    "clusters:read": {
        "description": "List and view cluster details",
        "applies_to": ["GET /v1/enterprise/clusters", "GET /v1/enterprise/clusters/{id}"],
    },
    "clusters:submit_job": {
        "description": "Submit compute jobs to clusters",
        "applies_to": ["POST /v1/enterprise/jobs/submit"],
    },
    "clusters:manage_keys": {
        "description": "Create, revoke, and manage API keys",
        "applies_to": [
            "POST /v1/enterprise/api-keys",
            "GET /v1/enterprise/api-keys",
            "POST /v1/enterprise/api-keys/{id}/revoke",
        ],
    },
    "jobs:read": {
        "description": "List and view job details",
        "applies_to": ["GET /v1/enterprise/jobs", "GET /v1/enterprise/jobs/{id}"],
    },
}


def validate_scopes(requested: list[str]) -> bool:
    """Check if all requested scopes are valid."""
    return all(s in ENTERPRISE_SCOPES for s in requested)


def get_scope_description(scope: str) -> str:
    """Get human-readable description for a scope."""
    return ENTERPRISE_SCOPES.get(scope, {}).get("description", "Unknown scope")
