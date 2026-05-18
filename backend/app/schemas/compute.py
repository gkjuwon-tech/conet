"""Schemas for the `/v1/compute/*` endpoints used by SDK clients.

The compute endpoints are a thin, opinionated wrapper around the legacy
``POST /v1/jobs`` flow. They are authenticated with a *cluster* key
(``em_cluster_…``) and pin the resulting Job to the cluster that the
caller already paid for via the marketplace.
"""

from __future__ import annotations

from datetime import datetime
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator

from app.db.models.job import JobKind, JobStatus


class ComputePayload(BaseModel):
    """The body of ``POST /v1/compute/run`` \u2014 *one* of the kind-specific
    fields must be set, mirroring :class:`app.schemas.job.JobSubmit`.

    The endpoint deliberately exposes the same kinds the platform already
    knows how to dispatch (hashcrack.range, hashcrack.dict, fhe.share, etc.)
    plus an escape hatch ``raw_manifest`` for bring-your-own work.
    """

    model_config = ConfigDict(extra="forbid")

    kind: JobKind
    label: str | None = Field(default=None, max_length=160)

    # Optional cap for THIS run (in addition to the key-level budget cap).
    max_budget_cents: int | None = Field(default=None, ge=100)
    max_runtime_seconds: int = Field(default=3600, ge=60, le=86400)
    redundancy: int = Field(default=1, ge=1, le=5)

    # Exactly one of these must be set.
    hashcrack_range: dict[str, Any] | None = None
    hashcrack_dict: dict[str, Any] | None = None
    fhe_share: dict[str, Any] | None = None
    raw_manifest: dict[str, Any] | None = None

    # Optional fire-and-forget callback.
    callback_url: str | None = Field(default=None, max_length=2048)

    @model_validator(mode="after")
    def _exactly_one_payload(self) -> "ComputePayload":
        present = [
            x is not None
            for x in (
                self.hashcrack_range,
                self.hashcrack_dict,
                self.fhe_share,
                self.raw_manifest,
            )
        ]
        if sum(present) != 1:
            raise ValueError(
                "exactly one of hashcrack_range / hashcrack_dict / fhe_share / "
                "raw_manifest is required"
            )
        return self


class ComputeRunCreated(BaseModel):
    """Lightweight response \u2014 SDKs typically poll ``GET /v1/compute/runs/{id}``."""

    run_id: str
    job_id: str
    job_handle: str
    cluster_id: str
    status: Literal[
        "queued",
        "leasing",
        "running",
        "succeeded",
        "failed",
        "cancelled",
        "timed_out",
        "rejected",
        "draft",
    ]
    submitted_at: datetime | None


class ComputeRunPublic(BaseModel):
    """Detailed run view returned by ``GET /v1/compute/runs/{id}``."""

    model_config = ConfigDict(from_attributes=True)

    run_id: str
    job_id: str
    job_handle: str
    cluster_id: str
    status: JobStatus

    label: str | None
    kind: JobKind

    workunit_total: int
    workunit_completed: int
    workunit_failed: int

    spent_cents: int
    max_budget_cents: int
    max_runtime_seconds: int

    submitted_at: datetime | None
    started_at: datetime | None
    finished_at: datetime | None

    # Aggregated result blob \u2014 populated when status is terminal.
    output: dict[str, Any] = Field(default_factory=dict)
