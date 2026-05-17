from __future__ import annotations

from datetime import datetime
from typing import Any

from pydantic import BaseModel, ConfigDict, Field

from app.db.models.lan_claim import LanClaimStatus


class LanClaimRequest(BaseModel):
    model_config = ConfigDict(str_strip_whitespace=True)

    lan_fingerprint: str = Field(min_length=8, max_length=64)
    label: str | None = Field(default=None, max_length=120)
    gateway_ip: str | None = None
    gateway_mac: str | None = Field(default=None, max_length=40)
    advertised_subnet: str | None = Field(default=None, max_length=40)


class LanClaimRequestPublic(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: str
    lan_fingerprint: str
    status: LanClaimStatus
    label: str | None
    otp_expires_at: datetime | None
    grace_until: datetime | None
    verified_at: datetime | None
    advertised_subnet: str | None
    gateway_ip: str | None
    gateway_mac: str | None
    is_active: bool
    metadata_: dict[str, Any] = Field(default_factory=dict, alias="metadata_")
    delivered_otp_dev: str | None = Field(
        default=None,
        description=(
            "Plaintext OTP, populated only when EM_LAN_CLAIM_DEV_SHOW_OTP is on. "
            "Production deployments deliver the OTP via email."
        ),
    )


class LanClaimVerify(BaseModel):
    model_config = ConfigDict(str_strip_whitespace=True)

    lan_fingerprint: str = Field(min_length=8, max_length=64)
    otp: str = Field(min_length=4, max_length=12)


class LanClaimDispute(BaseModel):
    lan_fingerprint: str = Field(min_length=8, max_length=64)
    reason: str = Field(max_length=512)
