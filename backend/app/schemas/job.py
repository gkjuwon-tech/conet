from __future__ import annotations

from datetime import datetime
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator

from app.db.models.job import JobKind, JobStatus
from app.db.models.workunit import WorkUnitStatus


class IsolationPolicy(BaseModel):
    forbid_plaintext: bool = True
    forbid_keys: bool = True
    chunk_only: bool = True
    require_attestation: bool = False
    encryption: Literal["none", "aes_gcm", "fhe", "mpc"] = "aes_gcm"
    redact_fields: list[str] = Field(default_factory=list)


class HashCrackRangeInput(BaseModel):
    algorithm: Literal["sha256", "sha512", "md5", "ntlm", "bcrypt", "argon2id"]
    target_hash: str = Field(min_length=8, max_length=512)
    salt: str | None = Field(default=None, max_length=256)
    charset: str = Field(min_length=1, max_length=512)
    min_length: int = Field(ge=1, le=64)
    max_length: int = Field(ge=1, le=64)
    chunk_size: int = Field(default=1_000_000, ge=10_000, le=10_000_000_000)

    @model_validator(mode="after")
    def _len_order(self) -> "HashCrackRangeInput":
        if self.min_length > self.max_length:
            raise ValueError("min_length must be <= max_length")
        return self


class HashCrackDictInput(BaseModel):
    algorithm: Literal["sha256", "sha512", "md5", "ntlm", "bcrypt", "argon2id"]
    target_hash: str = Field(min_length=8, max_length=512)
    salt: str | None = None
    wordlist_uri: str = Field(min_length=4)
    rules_uri: str | None = None
    chunk_size: int = Field(default=200_000, ge=1_000, le=10_000_000)


class FheShareInput(BaseModel):
    scheme: Literal["bfv", "bgv", "ckks", "tfhe"]
    public_params_uri: str
    ciphertext_chunks_uri: str
    op: Literal["sum", "dot", "matmul", "polyeval"]
    shape: list[int] = Field(default_factory=list)


class JobSubmit(BaseModel):
    model_config = ConfigDict(extra="forbid")

    kind: JobKind
    title: str | None = Field(default=None, max_length=160)
    description: str | None = Field(default=None, max_length=2000)

    target_cluster_count: int = Field(default=1, ge=1, le=128)
    target_h100_equivalent: float = Field(default=1.0, ge=0)
    max_budget_cents: int = Field(ge=100)
    max_runtime_seconds: int = Field(default=3600, ge=60, le=86400)
    redundancy: int = Field(default=2, ge=1, le=5)
    consensus_threshold: float = Field(default=0.66, ge=0.5, le=1.0)

    hashcrack_range: HashCrackRangeInput | None = None
    hashcrack_dict: HashCrackDictInput | None = None
    fhe_share: FheShareInput | None = None
    raw_manifest: dict[str, Any] | None = None

    isolation_policy: IsolationPolicy = Field(default_factory=IsolationPolicy)
    callback_url: str | None = Field(default=None, max_length=2048)

    @model_validator(mode="after")
    def _exactly_one_payload(self) -> "JobSubmit":
        present = [
            x is not None
            for x in (self.hashcrack_range, self.hashcrack_dict, self.fhe_share, self.raw_manifest)
        ]
        if sum(present) != 1:
            raise ValueError("exactly one of hashcrack_range/hashcrack_dict/fhe_share/raw_manifest required")
        return self


class JobPublic(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: str
    handle: str
    enterprise_id: str
    kind: JobKind
    status: JobStatus

    title: str | None
    description: str | None

    target_cluster_count: int
    target_h100_equivalent: float
    max_budget_cents: int
    max_runtime_seconds: int

    workunit_total: int
    workunit_completed: int
    workunit_failed: int

    spent_cents: int
    paid_to_users_cents: int
    platform_fee_cents: int

    submitted_at: datetime | None
    started_at: datetime | None
    finished_at: datetime | None
    deadline_at: datetime | None


class JobDetail(JobPublic):
    input_manifest: dict[str, Any]
    isolation_policy: dict[str, Any]
    output_manifest: dict[str, Any]


class WorkUnitPublic(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: str
    handle: str
    job_id: str
    sequence_no: int
    status: WorkUnitStatus
    weight: float
    expected_runtime_seconds: int
    redundancy_required: int
    redundancy_satisfied: int
    final_result_hash: str | None
    consensus_score: float | None
    dispatched_at: datetime | None
    completed_at: datetime | None
    deadline_at: datetime | None


class WorkUnitDispatch(BaseModel):
    workunit_id: str
    handle: str
    job_id: str
    kind: JobKind
    payload: dict[str, Any]
    expected_runtime_seconds: int
    deadline_at: datetime
    isolation_policy: dict[str, Any]


class WorkUnitResultSubmit(BaseModel):
    model_config = ConfigDict(extra="forbid")

    workunit_id: str
    runtime_ms: int = Field(ge=0)
    result: dict[str, Any]
    result_hash: str = Field(min_length=8, max_length=128)
    proof: str | None = Field(default=None, max_length=2048)
    error_code: str | None = Field(default=None, max_length=64)
    error_message: str | None = Field(default=None, max_length=1024)


class JobCancel(BaseModel):
    reason: str | None = Field(default=None, max_length=512)
