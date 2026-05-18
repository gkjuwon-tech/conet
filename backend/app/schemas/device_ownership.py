from __future__ import annotations

from datetime import datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

from app.db.models.device_ownership import (
    OwnershipChallengeMethod,
    OwnershipChallengeStatus,
)


class OwnershipChallengeCreate(BaseModel):
    """Open a fresh challenge against a (device_ip, method) pair."""

    model_config = ConfigDict(str_strip_whitespace=True)

    device_ip: str = Field(..., max_length=45)
    method: OwnershipChallengeMethod
    device_mac: str | None = Field(default=None, max_length=40)
    expected_serial: str | None = Field(default=None, max_length=128)
    public_key_pem: str | None = Field(default=None, max_length=2048)


class OwnershipChallengePublic(BaseModel):
    """What the renderer is allowed to see about a challenge.

    Notably absent: ``pin_hash``, ``pin_salt``, ``nonce``. ``rendered_pin``
    is included only when the deployment is in dev mode (it lets the
    consumer app show the PIN to the user when there is no real device to
    push it to). In production we expect the consumer's main process to
    push the PIN to the device via the same vendor channel that will
    install the agent.
    """

    model_config = ConfigDict(from_attributes=True)

    challenge_id: str
    device_ip: str
    method: OwnershipChallengeMethod
    status: OwnershipChallengeStatus
    expires_at: datetime
    attempts: int
    max_attempts: int
    rendered_pin: str | None = None
    delivery_hint: str | None = None


class OwnershipChallengeRespond(BaseModel):
    model_config = ConfigDict(str_strip_whitespace=True)

    challenge_id: str = Field(..., max_length=40)
    pin: str | None = Field(default=None, min_length=6, max_length=12)
    mac: str | None = Field(default=None, max_length=40)
    serial: str | None = Field(default=None, max_length=128)
    signature_hex: str | None = Field(default=None, max_length=2048)


class OwnershipVerifyResult(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    challenge_id: str
    device_ip: str
    status: OwnershipChallengeStatus
    verified: bool
    attempts: int
    max_attempts: int
    message: str
    verified_at: datetime | None = None


class OwnershipStatus(BaseModel):
    """Polled by the renderer to surface lockouts / TTLs."""

    model_config = ConfigDict(from_attributes=True)

    device_ip: str
    has_active_challenge: bool
    challenge_id: str | None = None
    method: OwnershipChallengeMethod | None = None
    status: OwnershipChallengeStatus | None = None
    expires_at: datetime | None = None
    attempts: int = 0
    max_attempts: int = 5
    is_verified: bool = False


# Backwards-compatible shim shapes — these keep the old
# ``/v1/claim/ownership/*`` endpoints working for old desktop builds in
# the field.

class LegacyPinChallengeRequest(BaseModel):
    device_ip: str = Field(..., max_length=45)


class LegacyPinVerifyRequest(BaseModel):
    device_ip: str = Field(..., max_length=45)
    pin: str = Field(..., min_length=6, max_length=6)


class LegacyMacVerifyRequest(BaseModel):
    device_ip: str = Field(..., max_length=45)
    mac: str = Field(..., max_length=40)
    serial: str | None = Field(default=None, max_length=128)


class LegacyChallengeStartResponse(BaseModel):
    challenge_id: str
    challenge_type: Literal["pin_display", "mac_serial"]
    expires_in_seconds: int
    pin_visible_to_user: bool
    pin: str | None = None


class LegacyVerifyResponse(BaseModel):
    ok: bool
    device_ip: str
    verified: bool
    message: str
