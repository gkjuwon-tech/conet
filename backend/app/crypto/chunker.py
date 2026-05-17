from __future__ import annotations

import hashlib
import math
from collections.abc import Iterator
from dataclasses import dataclass
from typing import Any

from app.schemas.job import HashCrackDictInput, HashCrackRangeInput


@dataclass(slots=True)
class WorkChunk:
    sequence_no: int
    payload: dict[str, Any]
    payload_hash: str
    expected_runtime_seconds: int
    weight: float


def chunk_hashcrack_range(spec: HashCrackRangeInput) -> Iterator[WorkChunk]:
    charset = spec.charset
    radix = len(charset)
    seq = 0
    for length in range(spec.min_length, spec.max_length + 1):
        keyspace = radix**length
        if keyspace == 0:
            continue
        chunk_count = max(1, math.ceil(keyspace / spec.chunk_size))
        if chunk_count > 100000:
            raise ValueError(f"Keyspace too large. Requested {chunk_count} chunks, max allowed is 100000.")
        actual_chunk = math.ceil(keyspace / chunk_count)
        for i in range(chunk_count):
            lo = i * actual_chunk
            hi = min(keyspace, lo + actual_chunk)
            payload = {
                "kind": "hashcrack.range",
                "algorithm": spec.algorithm,
                "target_hash": spec.target_hash,
                "salt": spec.salt,
                "charset": charset,
                "length": length,
                "range_lo": lo,
                "range_hi": hi,
                "radix": radix,
            }
            yield WorkChunk(
                sequence_no=seq,
                payload=payload,
                payload_hash=_payload_hash(payload),
                expected_runtime_seconds=_estimate_runtime_seconds(spec.algorithm, hi - lo),
                weight=float(hi - lo),
            )
            seq += 1


def chunk_hashcrack_dict(spec: HashCrackDictInput, total_words: int) -> Iterator[WorkChunk]:
    if total_words <= 0:
        return
    chunk_count = max(1, math.ceil(total_words / spec.chunk_size))
    chunk_size = math.ceil(total_words / chunk_count)
    for idx in range(chunk_count):
        lo = idx * chunk_size
        hi = min(total_words, lo + chunk_size)
        payload = {
            "kind": "hashcrack.dict",
            "algorithm": spec.algorithm,
            "target_hash": spec.target_hash,
            "salt": spec.salt,
            "wordlist_uri": spec.wordlist_uri,
            "rules_uri": spec.rules_uri,
            "wordlist_chunk_uri": f"{spec.wordlist_uri}#chunk={idx}",
            "chunk_index": idx,
            "lo": lo,
            "hi": hi,
        }
        yield WorkChunk(
            sequence_no=idx,
            payload=payload,
            payload_hash=_payload_hash(payload),
            expected_runtime_seconds=_estimate_runtime_seconds(spec.algorithm, hi - lo),
            weight=float(hi - lo),
        )


def chunk_fhe_share(*, scheme: str, public_params_uri: str, ciphertext_chunks_uri: str, op: str, count: int) -> Iterator[WorkChunk]:
    for idx in range(count):
        payload = {
            "kind": "fhe.share",
            "scheme": scheme,
            "public_params_uri": public_params_uri,
            "ciphertext_chunk_uri": f"{ciphertext_chunks_uri}#share={idx}",
            "share_index": idx,
            "op": op,
        }
        yield WorkChunk(
            sequence_no=idx,
            payload=payload,
            payload_hash=_payload_hash(payload),
            expected_runtime_seconds=120,
            weight=1.0,
        )


def _payload_hash(payload: dict[str, Any]) -> str:
    import json

    return hashlib.sha256(
        json.dumps(payload, sort_keys=True, separators=(",", ":")).encode("utf-8")
    ).hexdigest()


def _estimate_runtime_seconds(algorithm: str, ops: int) -> int:
    rate = {
        "md5": 30_000_000,
        "sha256": 15_000_000,
        "sha512": 8_000_000,
        "ntlm": 80_000_000,
        "bcrypt": 40_000,
        "argon2id": 5_000,
    }.get(algorithm, 5_000_000)
    return max(15, min(900, int(ops / rate)))
