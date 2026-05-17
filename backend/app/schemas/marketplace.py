from __future__ import annotations

from pydantic import BaseModel, Field

from app.schemas.cluster import ClusterCard


class CartLine(BaseModel):
    cluster_id: str
    hours: float = Field(ge=0.05, le=720)


class Cart(BaseModel):
    lines: list[CartLine] = Field(default_factory=list)
    estimated_total_usd: float = 0.0
    estimated_total_h100_hours: float = 0.0


class Quote(BaseModel):
    cluster: ClusterCard
    hours: float
    usd_total: float
    expected_h100_hours: float
    confidence: float


class QuoteRequest(BaseModel):
    cluster_ids: list[str] = Field(min_length=1, max_length=64)
    hours: float = Field(ge=0.05, le=720)
