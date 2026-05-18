from __future__ import annotations

import enum
from datetime import datetime

from sqlalchemy import (
    BigInteger,
    Boolean,
    DateTime,
    Enum,
    ForeignKey,
    Index,
    String,
)
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db.base import Base
from app.utils.ids import new_ulid


class EnterpriseStatus(str, enum.Enum):
    pending = "pending"
    active = "active"
    paused = "paused"
    terminated = "terminated"


class EnterpriseApiKeyKind(str, enum.Enum):
    """Two kinds of enterprise API keys.

    - ``access`` keys (prefix ``em_live_``) authenticate the operator
      console / control-plane: list clusters, purchase them, manage
      sub-keys, view stats. These are issued directly by the dashboard.
    - ``cluster`` keys (prefix ``em_cluster_``) are issued **per cluster
      purchase** and are the *only* key kind that can submit workloads
      via ``POST /v1/compute/run``. They cannot manage other keys or
      touch any cluster other than the one they were minted for.
    """

    access = "access"
    cluster = "cluster"


class Enterprise(Base):
    __tablename__ = "enterprises"

    id: Mapped[str] = mapped_column(String(40), primary_key=True, default=new_ulid)
    name: Mapped[str] = mapped_column(String(160), nullable=False)
    slug: Mapped[str] = mapped_column(String(64), nullable=False, unique=True)

    status: Mapped[EnterpriseStatus] = mapped_column(
        Enum(EnterpriseStatus, name="enterprise_status"),
        default=EnterpriseStatus.pending,
        nullable=False,
    )

    contact_email: Mapped[str] = mapped_column(String(255), nullable=False)
    billing_email: Mapped[str | None] = mapped_column(String(255))
    tax_id: Mapped[str | None] = mapped_column(String(64))

    stripe_customer_id: Mapped[str | None] = mapped_column(String(64))
    credit_balance_cents: Mapped[int] = mapped_column(BigInteger, default=0, nullable=False)
    monthly_spend_cents: Mapped[int] = mapped_column(BigInteger, default=0, nullable=False)
    spend_cap_cents: Mapped[int | None] = mapped_column(BigInteger)

    allowed_workload_kinds: Mapped[list] = mapped_column(JSONB, default=list, nullable=False)
    compliance_tier: Mapped[str] = mapped_column(String(24), default="standard", nullable=False)

    sso_provider: Mapped[str | None] = mapped_column(String(40))
    sso_metadata: Mapped[dict] = mapped_column(JSONB, default=dict, nullable=False)

    metadata_: Mapped[dict] = mapped_column("metadata", JSONB, default=dict, nullable=False)

    api_keys: Mapped[list["EnterpriseApiKey"]] = relationship(
        back_populates="enterprise", cascade="all, delete-orphan"
    )

    __table_args__ = (Index("ix_enterprises_status", "status"),)


class EnterpriseApiKey(Base):
    __tablename__ = "enterprise_api_keys"

    id: Mapped[str] = mapped_column(String(40), primary_key=True, default=new_ulid)
    enterprise_id: Mapped[str] = mapped_column(
        ForeignKey("enterprises.id", ondelete="CASCADE"), nullable=False
    )
    label: Mapped[str] = mapped_column(String(120), nullable=False)
    key_prefix: Mapped[str] = mapped_column(String(16), nullable=False)
    key_hash: Mapped[str] = mapped_column(String(255), nullable=False)
    scopes: Mapped[list] = mapped_column(JSONB, default=list, nullable=False)

    kind: Mapped[EnterpriseApiKeyKind] = mapped_column(
        Enum(EnterpriseApiKeyKind, name="enterprise_api_key_kind"),
        default=EnterpriseApiKeyKind.access,
        nullable=False,
    )
    bound_cluster_id: Mapped[str | None] = mapped_column(
        ForeignKey("clusters.id", ondelete="SET NULL"), nullable=True
    )
    bound_lease_id: Mapped[str | None] = mapped_column(
        ForeignKey("cluster_leases.id", ondelete="SET NULL"), nullable=True
    )
    max_budget_cents: Mapped[int] = mapped_column(BigInteger, default=0, nullable=False)
    spent_cents: Mapped[int] = mapped_column(BigInteger, default=0, nullable=False)

    last_used_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    revoked_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    expires_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    is_active: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)

    enterprise: Mapped["Enterprise"] = relationship(back_populates="api_keys")

    __table_args__ = (
        Index("ix_enterprise_keys_prefix", "key_prefix"),
        Index("ix_enterprise_keys_kind_cluster", "kind", "bound_cluster_id"),
    )
