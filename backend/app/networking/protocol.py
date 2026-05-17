from __future__ import annotations

from enum import Enum
from typing import Any, Literal

from pydantic import BaseModel, Field


class AgentMessageType(str, Enum):
    hello = "hello"
    challenge = "challenge"
    challenge_response = "challenge_response"
    benchmark_request = "benchmark_request"
    benchmark_submit = "benchmark_submit"
    heartbeat = "heartbeat"
    request_work = "request_work"
    work_dispatch = "work_dispatch"
    work_progress = "work_progress"
    work_result = "work_result"
    error = "error"
    ack = "ack"
    pause = "pause"
    resume = "resume"
    shutdown = "shutdown"


class HelloFrame(BaseModel):
    type: Literal[AgentMessageType.hello] = AgentMessageType.hello
    device_handle: str
    agent_version: str
    capabilities: dict[str, Any] = Field(default_factory=dict)
    lan_fingerprint: str | None = None


class ChallengeFrame(BaseModel):
    type: Literal[AgentMessageType.challenge] = AgentMessageType.challenge
    challenge_id: str
    nonce: str
    difficulty: int
    method: Literal["pow", "rsa-pkcs1v15"]


class ChallengeResponseFrame(BaseModel):
    type: Literal[AgentMessageType.challenge_response] = AgentMessageType.challenge_response
    challenge_id: str
    candidate: str | None = None
    signature_hex: str | None = None


class BenchmarkRequestFrame(BaseModel):
    type: Literal[AgentMessageType.benchmark_request] = AgentMessageType.benchmark_request
    suite_id: str
    duration_seconds: int = 30


class BenchmarkSubmitFrame(BaseModel):
    type: Literal[AgentMessageType.benchmark_submit] = AgentMessageType.benchmark_submit
    suite_id: str
    payload: dict[str, Any]


class HeartbeatFrame(BaseModel):
    type: Literal[AgentMessageType.heartbeat] = AgentMessageType.heartbeat
    cpu_usage_pct: float
    gpu_usage_pct: float = 0
    ram_usage_pct: float = 0
    temperature_c: float | None = None
    rssi_dbm: float | None = None
    download_mbps: float | None = None
    upload_mbps: float | None = None
    extras: dict[str, Any] = Field(default_factory=dict)


class RequestWorkFrame(BaseModel):
    type: Literal[AgentMessageType.request_work] = AgentMessageType.request_work
    capacity_hint: dict[str, float] = Field(default_factory=dict)
    max_units: int = 1


class WorkDispatchFrame(BaseModel):
    type: Literal[AgentMessageType.work_dispatch] = AgentMessageType.work_dispatch
    workunit_id: str
    workunit_handle: str
    job_id: str
    job_kind: str
    payload: dict[str, Any]
    expected_runtime_seconds: int
    deadline_iso: str
    isolation_policy: dict[str, Any] = Field(default_factory=dict)


class WorkProgressFrame(BaseModel):
    type: Literal[AgentMessageType.work_progress] = AgentMessageType.work_progress
    workunit_id: str
    progress_pct: float
    notes: str | None = None


class WorkResultFrame(BaseModel):
    type: Literal[AgentMessageType.work_result] = AgentMessageType.work_result
    workunit_id: str
    runtime_ms: int
    result: dict[str, Any]
    result_hash: str
    proof: str | None = None
    error_code: str | None = None
    error_message: str | None = None


class ErrorFrame(BaseModel):
    type: Literal[AgentMessageType.error] = AgentMessageType.error
    code: str
    message: str
    detail: dict[str, Any] = Field(default_factory=dict)


class AckFrame(BaseModel):
    type: Literal[AgentMessageType.ack] = AgentMessageType.ack
    ref: str | None = None


class PauseFrame(BaseModel):
    type: Literal[AgentMessageType.pause] = AgentMessageType.pause
    reason: str | None = None
    resume_after_seconds: int | None = None


class ResumeFrame(BaseModel):
    type: Literal[AgentMessageType.resume] = AgentMessageType.resume


class ShutdownFrame(BaseModel):
    type: Literal[AgentMessageType.shutdown] = AgentMessageType.shutdown
    reason: str | None = None
