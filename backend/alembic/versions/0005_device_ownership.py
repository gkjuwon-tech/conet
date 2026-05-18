"""device ownership challenges + audit (replaces in-memory haiku-era state)

Revision ID: 0005_device_ownership
Revises: 0004_two_kind_api_keys
Create Date: 2026-05-18
"""
from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

from alembic import op

revision: str = "0005_device_ownership"
down_revision: str | None = "0004_two_kind_api_keys"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.execute(
        "CREATE TYPE device_ownership_method AS ENUM "
        "('pin_display','mac_serial','signed_attestation')"
    )
    op.execute(
        "CREATE TYPE device_ownership_status AS ENUM "
        "('pending','verified','consumed','expired','locked','cancelled')"
    )
    op.execute(
        "CREATE TYPE device_ownership_audit_event AS ENUM ("
        "'challenge_created','response_accepted','response_rejected',"
        "'challenge_expired','challenge_locked','challenge_cancelled',"
        "'verification_consumed'"
        ")"
    )

    op.create_table(
        "device_ownership_challenges",
        sa.Column("id", sa.String(40), primary_key=True),
        sa.Column(
            "user_id",
            sa.String(40),
            sa.ForeignKey("users.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("device_ip", postgresql.INET(), nullable=False),
        sa.Column("device_mac", sa.String(40)),
        sa.Column("expected_mac", sa.String(40)),
        sa.Column("expected_serial", sa.String(128)),
        sa.Column(
            "method",
            postgresql.ENUM(name="device_ownership_method", create_type=False),
            nullable=False,
        ),
        sa.Column(
            "status",
            postgresql.ENUM(name="device_ownership_status", create_type=False),
            nullable=False,
        ),
        sa.Column("nonce", sa.String(64), nullable=False),
        sa.Column("pin_hash", sa.String(128)),
        sa.Column("pin_salt", sa.String(64)),
        sa.Column("public_key_pem", sa.String(2048)),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("verified_at", sa.DateTime(timezone=True)),
        sa.Column("consumed_at", sa.DateTime(timezone=True)),
        sa.Column("attempts", sa.Integer, nullable=False, server_default="0"),
        sa.Column("max_attempts", sa.Integer, nullable=False, server_default="5"),
        sa.Column("requester_ip", postgresql.INET()),
        sa.Column("requester_user_agent", sa.String(255)),
        sa.Column(
            "delivery",
            postgresql.JSONB,
            nullable=False,
            server_default=sa.text("'{}'::jsonb"),
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
        "ix_device_ownership_user_ip_status",
        "device_ownership_challenges",
        ["user_id", "device_ip", "status"],
    )
    op.create_index(
        "ix_device_ownership_expires",
        "device_ownership_challenges",
        ["expires_at"],
    )

    op.create_table(
        "device_ownership_audit",
        sa.Column("id", sa.String(40), primary_key=True),
        sa.Column(
            "challenge_id",
            sa.String(40),
            sa.ForeignKey("device_ownership_challenges.id", ondelete="SET NULL"),
            nullable=True,
        ),
        sa.Column(
            "user_id",
            sa.String(40),
            sa.ForeignKey("users.id", ondelete="SET NULL"),
            nullable=True,
        ),
        sa.Column("device_ip", postgresql.INET()),
        sa.Column(
            "event",
            postgresql.ENUM(name="device_ownership_audit_event", create_type=False),
            nullable=False,
        ),
        sa.Column(
            "detail",
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
        "ix_device_ownership_audit_user_time",
        "device_ownership_audit",
        ["user_id", "created_at"],
    )
    op.create_index(
        "ix_device_ownership_audit_ip_time",
        "device_ownership_audit",
        ["device_ip", "created_at"],
    )


def downgrade() -> None:
    op.drop_table("device_ownership_audit")
    op.drop_table("device_ownership_challenges")
    op.execute("DROP TYPE IF EXISTS device_ownership_audit_event")
    op.execute("DROP TYPE IF EXISTS device_ownership_status")
    op.execute("DROP TYPE IF EXISTS device_ownership_method")
