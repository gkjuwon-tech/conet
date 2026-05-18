"""two-kind enterprise api keys (access vs cluster) + cluster_access_logs

Revision ID: 0004_two_kind_api_keys
Revises: 0003_billing_and_shell
Create Date: 2026-05-17
"""
from __future__ import annotations

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

revision: str = "0004_two_kind_api_keys"
down_revision: Union[str, None] = "0003_billing_and_shell"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # New enum for distinguishing access keys from cluster keys.
    op.execute(
        "CREATE TYPE enterprise_api_key_kind AS ENUM ('access','cluster')"
    )

    # Add the new columns to the existing enterprise_api_keys table.
    op.add_column(
        "enterprise_api_keys",
        sa.Column(
            "kind",
            postgresql.ENUM(name="enterprise_api_key_kind", create_type=False),
            nullable=False,
            server_default="access",
        ),
    )
    op.add_column(
        "enterprise_api_keys",
        sa.Column(
            "bound_cluster_id",
            sa.String(40),
            sa.ForeignKey("clusters.id", ondelete="SET NULL"),
            nullable=True,
        ),
    )
    op.add_column(
        "enterprise_api_keys",
        sa.Column(
            "bound_lease_id",
            sa.String(40),
            sa.ForeignKey("cluster_leases.id", ondelete="SET NULL"),
            nullable=True,
        ),
    )
    op.add_column(
        "enterprise_api_keys",
        sa.Column(
            "max_budget_cents",
            sa.BigInteger,
            nullable=False,
            server_default="0",
        ),
    )
    op.add_column(
        "enterprise_api_keys",
        sa.Column(
            "spent_cents",
            sa.BigInteger,
            nullable=False,
            server_default="0",
        ),
    )

    op.create_index(
        "ix_enterprise_keys_kind_cluster",
        "enterprise_api_keys",
        ["kind", "bound_cluster_id"],
    )


def downgrade() -> None:
    op.drop_index(
        "ix_enterprise_keys_kind_cluster",
        table_name="enterprise_api_keys",
    )
    op.drop_column("enterprise_api_keys", "spent_cents")
    op.drop_column("enterprise_api_keys", "max_budget_cents")
    op.drop_column("enterprise_api_keys", "bound_lease_id")
    op.drop_column("enterprise_api_keys", "bound_cluster_id")
    op.drop_column("enterprise_api_keys", "kind")
    op.execute("DROP TYPE IF EXISTS enterprise_api_key_kind")
