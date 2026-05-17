from __future__ import annotations

from app.crypto.chunker import chunk_hashcrack_range
from app.schemas.job import HashCrackRangeInput


def test_chunker_covers_keyspace() -> None:
    spec = HashCrackRangeInput(
        algorithm="md5",
        target_hash="0" * 32,
        charset="abcd",
        min_length=2,
        max_length=2,
        chunk_size=4,
    )
    chunks = list(chunk_hashcrack_range(spec))
    keyspace_each = sum(c.payload["range_hi"] - c.payload["range_lo"] for c in chunks)
    assert keyspace_each == 16
    assert all(c.payload["range_hi"] > c.payload["range_lo"] for c in chunks)
    assert len(set(c.payload_hash for c in chunks)) == len(chunks)


def test_chunker_multiple_lengths() -> None:
    spec = HashCrackRangeInput(
        algorithm="sha256",
        target_hash="d" * 64,
        charset="ab",
        min_length=2,
        max_length=4,
        chunk_size=8,
    )
    chunks = list(chunk_hashcrack_range(spec))
    by_length: dict[int, int] = {}
    for c in chunks:
        by_length[c.payload["length"]] = (
            by_length.get(c.payload["length"], 0) + (c.payload["range_hi"] - c.payload["range_lo"])
        )
    assert by_length[2] == 4
    assert by_length[3] == 8
    assert by_length[4] == 16
