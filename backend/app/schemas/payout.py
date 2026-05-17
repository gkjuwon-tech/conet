from __future__ import annotations

from datetime import datetime

from pydantic import BaseModel, ConfigDict

from app.db.models.payout import PayoutStatus


class PayoutPublic(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: str
    handle: str
    amount_cents: int
    currency: str
    status: PayoutStatus
    period_start: datetime
    period_end: datetime
    method: str
    initiated_at: datetime | None
    settled_at: datetime | None
    failure_reason: str | None


class LedgerEntryPublic(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: str
    amount_cents: int
    occurred_at: datetime
    note: str | None
    job_id: str | None
    workunit_id: str | None
    device_id: str | None


class PayoutPage(BaseModel):
    items: list[PayoutPublic]
    next_cursor: str | None


class PayoutRequest(BaseModel):
    method: str = "stripe"
    confirm: bool = True
