"""billing tables, shell sessions, and compute.shell job kind

Revision ID: 0003_billing_and_shell
Revises: 0002_lan_claims
Create Date: 2026-05-08
"""
from __future__ import annotations

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

revision: str = "0003_billing_and_shell"
down_revision: Union[str, None] = "0002_lan_claims"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # Add the new enum value to job_kind
    op.execute("ALTER TYPE job_kind ADD VALUE IF NOT EXISTS 'compute.shell'")

    op.execute(
        "CREATE TYPE invoice_kind AS ENUM "
        "('topup','refund','promotional_credit','chargeback')"
    )
    op.execute(
        "CREATE TYPE invoice_status AS ENUM "
        "('pending','succeeded','failed','refunded','cancelled')"
    )
    op.execute(
        "CREATE TYPE charge_reason AS ENUM "
        "('job_authorization_hold','job_authorization_release',"
        "'job_settlement','shell_session_metered','adjustment')"
    )
    op.execute(
        "CREATE TYPE shell_session_status AS ENUM "
        "('pending','waiting_device','active','expired','closed','revoked')"
    )

    op.create_table(
        "enterprise_invoices",
        sa.Column("id", sa.String(40), primary_key=True),
        sa.Column(
            "enterprise_id",
            sa.String(40),
            sa.ForeignKey("enterprises.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("kind", postgresql.ENUM(name="invoice_kind", create_type=False), nullable=False),
        sa.Column(
            "status",
            postgresql.ENUM(name="invoice_status", create_type=False),
            nullable=False,
        ),
        sa.Column("amount_cents", sa.BigInteger, nullable=False),
        sa.Column("currency", sa.String(3), nullable=False, server_default="USD"),
        sa.Column("description", sa.String(255)),
        sa.Column("stripe_payment_intent_id", sa.String(80)),
        sa.Column("stripe_charge_id", sa.String(80)),
        sa.Column("stripe_customer_id", sa.String(80)),
        sa.Column("stripe_client_secret", sa.String(255)),
        sa.Column("stripe_status", sa.String(40)),
        sa.Column("initiated_by_user_id", sa.String(40)),
        sa.Column("paid_at", sa.DateTime(timezone=True)),
        sa.Column("failed_at", sa.DateTime(timezone=True)),
        sa.Column("failure_reason", sa.String(512)),
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
    )
    op.create_index(
        "ix_invoices_enterprise_status",
        "enterprise_invoices",
        ["enterprise_id", "status"],
    )
    op.create_index("ix_invoices_pi", "enterprise_invoices", ["stripe_payment_intent_id"])

    op.create_table(
        "enterprise_charges",
        sa.Column("id", sa.String(40), primary_key=True),
        sa.Column(
            "enterprise_id",
            sa.String(40),
            sa.ForeignKey("enterprises.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column(
            "reason",
            postgresql.ENUM(name="charge_reason", create_type=False),
            nullable=False,
        ),
        sa.Column("amount_cents", sa.BigInteger, nullable=False),
        sa.Column("job_id", sa.String(40), sa.ForeignKey("jobs.id", ondelete="SET NULL")),
        sa.Column("shell_session_id", sa.String(40)),
        sa.Column("occurred_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("description", sa.String(255)),
        sa.Column(
            "is_finalized",
            sa.Boolean,
            nullable=False,
            server_default=sa.text("true"),
        ),
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
    )
    op.create_index(
        "ix_charges_enterprise_time",
        "enterprise_charges",
        ["enterprise_id", "occurred_at"],
    )
    op.create_index("ix_charges_job", "enterprise_charges", ["job_id"])
    op.create_index("ix_charges_reason", "enterprise_charges", ["reason"])

    op.create_table(
        "shell_sessions",
        sa.Column("id", sa.String(40), primary_key=True),
        sa.Column(
            "enterprise_id",
            sa.String(40),
            sa.ForeignKey("enterprises.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column(
            "job_id",
            sa.String(40),
            sa.ForeignKey("jobs.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column(
            "device_id",
            sa.String(40),
            sa.ForeignKey("devices.id", ondelete="RESTRICT"),
            nullable=False,
        ),
        sa.Column(
            "status",
            postgresql.ENUM(name="shell_session_status", create_type=False),
            nullable=False,
        ),
        sa.Column("enterprise_token", sa.String(80), nullable=False, unique=True),
        sa.Column("device_token", sa.String(80), nullable=False, unique=True),
        sa.Column("image", sa.String(160)),
        sa.Column("workdir", sa.String(256)),
        sa.Column("env", postgresql.JSONB, nullable=False, server_default=sa.text("'{}'::jsonb")),
        sa.Column("cmd", sa.String(512)),
        sa.Column("cpu_cap_pct", sa.Float, nullable=False, server_default="80"),
        sa.Column("memory_mb_cap", sa.Integer, nullable=False, server_default="2048"),
        sa.Column("disk_mb_cap", sa.Integer, nullable=False, server_default="4096"),
        sa.Column("network_egress_mbps_cap", sa.Float, nullable=False, server_default="10"),
        sa.Column("created_at_ts", sa.DateTime(timezone=True), nullable=False),
        sa.Column("activated_at", sa.DateTime(timezone=True)),
        sa.Column("last_io_at", sa.DateTime(timezone=True)),
        sa.Column("closed_at", sa.DateTime(timezone=True)),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("rate_usd_per_hour", sa.Float, nullable=False, server_default="0"),
        sa.Column("runtime_seconds", sa.BigInteger, nullable=False, server_default="0"),
        sa.Column("metered_cents", sa.BigInteger, nullable=False, server_default="0"),
        sa.Column("bytes_in", sa.BigInteger, nullable=False, server_default="0"),
        sa.Column("bytes_out", sa.BigInteger, nullable=False, server_default="0"),
        sa.Column("revoked_reason", sa.String(255)),
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
    )
    op.create_index(
        "ix_shell_enterprise_status",
        "shell_sessions",
        ["enterprise_id", "status"],
    )
    op.create_index("ix_shell_device", "shell_sessions", ["device_id", "status"])
    op.create_index("ix_shell_expires", "shell_sessions", ["expires_at"])


def downgrade() -> None:
    op.drop_table("shell_sessions")
    op.drop_table("enterprise_charges")
    op.drop_table("enterprise_invoices")
    for t in ("shell_session_status", "charge_reason", "invoice_status", "invoice_kind"):
        op.execute(f"DROP TYPE IF EXISTS {t}")
