from __future__ import annotations

import hashlib
from typing import Any


SUPPORTED = {"md5", "sha256", "sha512", "ntlm"}


def candidate_to_index(charset: str, length: int, index: int) -> str:
    radix = len(charset)
    chars: list[str] = []
    for _ in range(length):
        chars.append(charset[index % radix])
        index //= radix
    return "".join(reversed(chars))


def index_to_candidate(charset: str, length: int, index: int) -> str:
    return candidate_to_index(charset, length, index)


def hash_candidate(algorithm: str, candidate: str, salt: str | None) -> str:
    salted = (salt or "") + candidate
    if algorithm == "md5":
        return hashlib.md5(salted.encode("utf-8")).hexdigest()
    if algorithm == "sha256":
        return hashlib.sha256(salted.encode("utf-8")).hexdigest()
    if algorithm == "sha512":
        return hashlib.sha512(salted.encode("utf-8")).hexdigest()
    if algorithm == "ntlm":
        return hashlib.new("md4", candidate.encode("utf-16-le")).hexdigest()
    raise ValueError(f"unsupported algorithm: {algorithm}")


def search_range(payload: dict[str, Any]) -> dict[str, Any]:
    """Reference implementation used in tests / fallback worker.

    Real workers run native binaries; this is the canonical CPU baseline that
    devices echo for verification chunks.
    """
    algo = payload["algorithm"]
    if algo not in SUPPORTED:
        return {"status": "unsupported", "algorithm": algo}
    target = payload["target_hash"].lower()
    salt = payload.get("salt")
    charset = payload["charset"]
    length = int(payload["length"])
    lo = int(payload["range_lo"])
    hi = int(payload["range_hi"])

    found: str | None = None
    for i in range(lo, hi):
        cand = candidate_to_index(charset, length, i)
        if hash_candidate(algo, cand, salt) == target:
            found = cand
            break

    return {
        "status": "hit" if found else "miss",
        "candidate": found,
        "scanned": hi - lo,
        "range_lo": lo,
        "range_hi": hi,
        "length": length,
    }


def verification_pair(algorithm: str) -> tuple[str, str]:
    sample = "verify-" + algorithm
    return sample, hash_candidate(algorithm, sample, None)
