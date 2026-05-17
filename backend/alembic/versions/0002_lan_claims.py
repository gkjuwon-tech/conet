"""lan ownership claims (anti-hijack)

Revision ID: 0002_lan_claims
Revises: 0001_initial
Create Date: 2026-05-08
"""
from __future__ import annotations

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

revision: str = "0002_lan_claims"
down_revision: Union[str, None] = "0001_initial"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.execute(
        "CREATE TYPE lan_claim_status AS ENUM "
        "('pending_otp','verified','expired','revoked','disputed')"
    )

    op.create_table(
        "lan_claims",
        sa.Column("id", sa.String(40), primary_key=True),
        sa.Column(
            "user_id",
            sa.String(40),
            sa.ForeignKey("users.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("lan_fingerprint", sa.String(64), nullable=False),
        sa.Column(
            "status",
            postgresql.ENUM(name="lan_claim_status", create_type=False),
            nullable=False,
        ),
        sa.Column("otp_hash", sa.String(128)),
        sa.Column("otp_expires_at", sa.DateTime(timezone=True)),
        sa.Column("otp_attempts", sa.Integer, nullable=False, server_default="0"),
        sa.Column("verified_at", sa.DateTime(timezone=True)),
        sa.Column("revoked_at", sa.DateTime(timezone=True)),
        sa.Column("grace_until", sa.DateTime(timezone=True)),
        sa.Column("requested_ip", postgresql.INET()),
        sa.Column("requested_user_agent", sa.String(255)),
        sa.Column("gateway_ip", postgresql.INET()),
        sa.Column("gateway_mac", sa.String(40)),
        sa.Column("advertised_subnet", sa.String(40)),
        sa.Column("label", sa.String(120)),
        sa.Column("is_active", sa.Boolean, nullable=False, server_default=sa.text("true")),
        sa.Column(
            "metadata",
            postgresql.JSONB,
            nullable=False,
            server_default=sa.text("'{}'::jsonb"),
        ),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.func.now(),
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.func.now(),
        ),
        sa.UniqueConstraint("user_id", "lan_fingerprint", name="uq_lan_claim_user_fp"),
    )
    op.create_index("ix_lan_claims_fp_status", "lan_claims", ["lan_fingerprint", "status"])
    op.create_index("ix_lan_claims_user", "lan_claims", ["user_id", "status"])


def downgrade() -> None:
    op.drop_table("lan_claims")
    op.execute("DROP TYPE IF EXISTS lan_claim_status")
