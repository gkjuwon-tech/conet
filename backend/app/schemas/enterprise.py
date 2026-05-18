from __future__ import annotations

from datetime import datetime
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, EmailStr, Field

from app.db.models.enterprise import EnterpriseApiKeyKind, EnterpriseStatus


class EnterpriseCreate(BaseModel):
    model_config = ConfigDict(str_strip_whitespace=True)

    name: str = Field(min_length=2, max_length=160)
    slug: str = Field(min_length=2, max_length=64, pattern=r"^[a-z0-9][a-z0-9_-]+$")
    contact_email: EmailStr
    billing_email: EmailStr | None = None
    tax_id: str | None = Field(default=None, max_length=64)
    allowed_workload_kinds: list[str] = Field(default_factory=list)
    compliance_tier: str = Field(default="standard", max_length=24)


class EnterprisePublic(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: str
    name: str
    slug: str
    status: EnterpriseStatus
    contact_email: str
    compliance_tier: str
    monthly_spend_cents: int
    credit_balance_cents: int
    spend_cap_cents: int | None
    allowed_workload_kinds: list[str] = Field(default_factory=list)


class ApiKeyCreate(BaseModel):
    label: str = Field(min_length=2, max_length=120)
    scopes: list[str] = Field(default_factory=lambda: ["clusters:read", "clusters:submit_job"])
    expires_in_days: int | None = Field(default=None, ge=1, le=3650)


class ApiKeyRevoke(BaseModel):
    reason: str | None = Field(default=None, max_length=512)


class ApiKeyCreated(BaseModel):
    id: str
    label: str
    api_key: str
    key_prefix: str
    scopes: list[str]
    kind: EnterpriseApiKeyKind = EnterpriseApiKeyKind.access
    bound_cluster_id: str | None = None
    expires_at: datetime | None


class ApiKeyPublic(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: str
    label: str
    key_prefix: str
    scopes: list[str]
    kind: EnterpriseApiKeyKind = EnterpriseApiKeyKind.access
    bound_cluster_id: str | None = None
    max_budget_cents: int = 0
    spent_cents: int = 0
    last_used_at: datetime | None
    revoked_at: datetime | None
    expires_at: datetime | None
    is_active: bool


class ClusterPurchase(BaseModel):
    """Buy compute on a specific cluster and mint a single cluster API key."""

    model_config = ConfigDict(extra="forbid")

    label: str = Field(
        min_length=2,
        max_length=120,
        description="Human-readable label, e.g. 'render-queue-prod'",
    )
    budget_cents: int = Field(
        ge=100,
        le=10_000_000_00,
        description=(
            "Hard cap on spend for this key, in USD cents. The key stops "
            "accepting work once spent_cents >= budget_cents."
        ),
    )
    expires_in_days: int | None = Field(default=None, ge=1, le=3650)


class ClusterPurchaseResult(BaseModel):
    """Returned from POST /v1/enterprise/clusters/{id}/purchase.

    The ``api_key`` field is shown ONLY ONCE — store it immediately.
    """

    id: str
    label: str
    api_key: str
    key_prefix: str
    kind: Literal["cluster"] = "cluster"
    bound_cluster_id: str
    max_budget_cents: int
    scopes: list[str]
    expires_at: datetime | None


class EnterpriseStats(BaseModel):
    jobs_active: int
    jobs_completed_30d: int
    spend_30d_cents: int
    avg_runtime_seconds_30d: float
    success_rate_30d: float
    metadata: dict[str, Any] = Field(default_factory=dict)
