from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Any

from app.config import get_settings
from app.db.models.job import JobKind
from app.exceptions import IsolationViolation


_SECRET_PATTERNS = [
    re.compile(r"-----BEGIN [A-Z ]*PRIVATE KEY-----"),
    re.compile(r"AKIA[0-9A-Z]{16}"),
    re.compile(r"sk_live_[A-Za-z0-9]+"),
    re.compile(r"ghp_[A-Za-z0-9]{36,}"),
    re.compile(r"xox[bp]-[A-Za-z0-9-]{20,}"),
    re.compile(r"aws_secret_access_key", re.IGNORECASE),
]

_PII_FIELDS = {
    "ssn",
    "social_security",
    "passport",
    "credit_card",
    "card_number",
    "cvv",
    "bank_account",
    "iban",
    "routing_number",
    "tax_id",
}


@dataclass(slots=True)
class IsolationVerdict:
    accepted: bool
    redacted_payload: dict[str, Any]
    violations: list[str]


def enforce_inbound_payload(
    *,
    job_kind: JobKind,
    raw_payload: dict[str, Any],
    isolation_policy: dict[str, Any],
) -> IsolationVerdict:
    settings = get_settings()
    violations: list[str] = []

    if job_kind.value not in settings.isolation_allowed_workload_kinds:
        raise IsolationViolation(
            f"workload kind {job_kind.value} not in allowlist",
            detail={"allowed": settings.isolation_allowed_workload_kinds},
        )

    flat = _flatten(raw_payload)

    for path, value in flat.items():
        last = path.rsplit(".", 1)[-1].lower()
        if last in _PII_FIELDS:
            violations.append(f"pii_field:{path}")
        if isinstance(value, str):
            for pat in _SECRET_PATTERNS:
                if pat.search(value):
                    violations.append(f"secret_pattern:{path}")
                    break

    if isolation_policy.get("forbid_plaintext"):
        if _looks_like_plaintext(raw_payload, job_kind):
            violations.append("plaintext_detected")

    if isolation_policy.get("chunk_only"):
        if not _has_chunk_marker(raw_payload, job_kind):
            violations.append("chunk_marker_missing")

    redacted = _redact(raw_payload, isolation_policy.get("redact_fields") or [])

    if violations:
        raise IsolationViolation(
            "payload failed isolation checks",
            detail={"violations": violations},
        )

    return IsolationVerdict(accepted=True, redacted_payload=redacted, violations=violations)


def sanitize_outbound_dispatch(payload: dict[str, Any]) -> dict[str, Any]:
    out = dict(payload)
    out.pop("master_key", None)
    out.pop("plaintext", None)
    out.pop("private_key", None)
    return out


def _flatten(d: Any, prefix: str = "") -> dict[str, Any]:
    out: dict[str, Any] = {}
    if isinstance(d, dict):
        for k, v in d.items():
            key = f"{prefix}.{k}" if prefix else k
            if isinstance(v, (dict, list)):
                out.update(_flatten(v, key))
            else:
                out[key] = v
    elif isinstance(d, list):
        for i, v in enumerate(d):
            key = f"{prefix}[{i}]"
            if isinstance(v, (dict, list)):
                out.update(_flatten(v, key))
            else:
                out[key] = v
    else:
        out[prefix] = d
    return out


def _looks_like_plaintext(payload: dict[str, Any], kind: JobKind) -> bool:
    if kind in (JobKind.fhe_share, JobKind.mpc_share):
        return any(k in payload for k in ("plaintext", "raw_data", "secret"))
    if kind in (JobKind.hashcrack_range, JobKind.hashcrack_dict):
        return "wordlist_inline" in payload and isinstance(payload.get("wordlist_inline"), str)
    return False


def _has_chunk_marker(payload: dict[str, Any], kind: JobKind) -> bool:
    """Accept either a per-workunit chunk OR a job-level spec that the chunker
    will split into chunks."""
    spec = payload.get("spec") if isinstance(payload, dict) else None
    if kind == JobKind.hashcrack_range:
        if "range_lo" in payload and "range_hi" in payload:
            return True
        if spec and "chunk_size" in spec and "charset" in spec:
            return True
        return False
    if kind == JobKind.hashcrack_dict:
        if "wordlist_chunk_uri" in payload or "chunk_index" in payload:
            return True
        if spec and "wordlist_uri" in spec and "chunk_size" in spec:
            return True
        return False
    if kind in (JobKind.fhe_share, JobKind.mpc_share):
        if "share_index" in payload or "ciphertext_chunk_uri" in payload:
            return True
        if spec and ("ciphertext_chunks_uri" in spec or "share_count" in spec):
            return True
        return False
    if kind == JobKind.render_tile:
        return "tile_x" in payload and "tile_y" in payload
    return True


def _redact(payload: dict[str, Any], redact_fields: list[str]) -> dict[str, Any]:
    if not redact_fields:
        return payload
    out: dict[str, Any] = {}
    rset = {f.lower() for f in redact_fields}
    for k, v in payload.items():
        if k.lower() in rset:
            out[k] = "<redacted>"
        elif isinstance(v, dict):
            out[k] = _redact(v, redact_fields)
        else:
            out[k] = v
    return out
