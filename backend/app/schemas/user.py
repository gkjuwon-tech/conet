from __future__ import annotations

from datetime import datetime
from typing import Any

from pydantic import BaseModel, ConfigDict, EmailStr, Field, SecretStr

from app.db.models.user import UserStatus


class UserBase(BaseModel):
    model_config = ConfigDict(from_attributes=True, str_strip_whitespace=True)

    email: EmailStr
    display_name: str | None = Field(default=None, max_length=120)
    country_code: str | None = Field(default=None, min_length=2, max_length=2)
    timezone: str | None = Field(default=None, max_length=64)
    locale: str = "en-US"


class UserCreate(UserBase):
    password: SecretStr = Field(min_length=10, max_length=128)
    accepted_tos_version: str = Field(min_length=1, max_length=16)
    referral_code: str | None = Field(default=None, max_length=16)


class UserLogin(BaseModel):
    email: EmailStr
    password: SecretStr
    otp: str | None = Field(default=None, min_length=6, max_length=10)


class UserPublic(UserBase):
    id: str
    status: UserStatus
    email_verified: bool
    two_factor_enabled: bool
    created_at: datetime
    referral_code: str | None
    settings: dict[str, Any] = Field(default_factory=dict)


class UserUpdate(BaseModel):
    model_config = ConfigDict(str_strip_whitespace=True)

    display_name: str | None = None
    country_code: str | None = Field(default=None, min_length=2, max_length=2)
    timezone: str | None = Field(default=None, max_length=64)
    locale: str | None = None
    payout_method: str | None = Field(default=None, max_length=40)
    settings: dict[str, Any] | None = None


class TokenPair(BaseModel):
    access_token: str
    refresh_token: str
    token_type: str = "Bearer"
    expires_in: int


class WalletSummary(BaseModel):
    available_cents: int
    pending_cents: int
    held_cents: int
    lifetime_earned_cents: int
    lifetime_paid_cents: int
    last_activity_at: datetime | None


class UserDashboard(BaseModel):
    user: UserPublic
    wallet: WalletSummary
    devices_online: int
    devices_total: int
    last_24h_earnings_cents: int
    pending_payout_cents: int
