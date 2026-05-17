from __future__ import annotations

import pytest

from app.db.models.job import JobKind
from app.exceptions import IsolationViolation
from app.services.isolation import enforce_inbound_payload


VALID_RANGE = {
    "kind": "hashcrack.range",
    "spec": {
        "algorithm": "sha256",
        "target_hash": "deadbeef" * 8,
        "charset": "abcdefghijklmnopqrstuvwxyz",
        "min_length": 4,
        "max_length": 6,
        "chunk_size": 1_000_000,
        "range_lo": 0,
        "range_hi": 1000,
    },
}


def test_accepts_valid_range() -> None:
    verdict = enforce_inbound_payload(
        job_kind=JobKind.hashcrack_range,
        raw_payload=VALID_RANGE,
        isolation_policy={"forbid_plaintext": True, "chunk_only": True},
    )
    assert verdict.accepted


def test_rejects_pii_field() -> None:
    payload = {**VALID_RANGE, "spec": {**VALID_RANGE["spec"], "ssn": "123-45-6789"}}
    with pytest.raises(IsolationViolation):
        enforce_inbound_payload(
            job_kind=JobKind.hashcrack_range,
            raw_payload=payload,
            isolation_policy={"forbid_plaintext": True, "chunk_only": True},
        )


def test_rejects_private_key_pattern() -> None:
    payload = {**VALID_RANGE, "extra": "-----BEGIN RSA PRIVATE KEY-----foo"}
    with pytest.raises(IsolationViolation):
        enforce_inbound_payload(
            job_kind=JobKind.hashcrack_range,
            raw_payload=payload,
            isolation_policy={"forbid_plaintext": True, "chunk_only": True},
        )


def test_disallowed_workload_kind_rejected() -> None:
    with pytest.raises(IsolationViolation):
        enforce_inbound_payload(
            job_kind=JobKind.mpc_share,
            raw_payload={"kind": "mpc.share", "share_index": 0},
            isolation_policy={},
        )
