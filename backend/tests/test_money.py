from __future__ import annotations

from decimal import Decimal

from app.utils.money import apply_bps, from_cents, split_pool, to_cents


def test_to_from_cents_roundtrip() -> None:
    assert to_cents(Decimal("12.34")) == 1234
    assert from_cents(1234) == Decimal("12.34")


def test_apply_bps() -> None:
    assert apply_bps(10_000, 1500) == 1500
    assert apply_bps(10_000, 0) == 0


def test_split_pool_preserves_total() -> None:
    shares = split_pool(1000, [1, 1, 1])
    assert sum(shares) == 1000
    assert max(shares) - min(shares) <= 1


def test_split_pool_weighted() -> None:
    shares = split_pool(1000, [3, 1])
    assert sum(shares) == 1000
    assert shares[0] > shares[1]


def test_split_pool_zero_weights() -> None:
    assert split_pool(500, [0, 0, 0]) == [0, 0, 0]
    assert split_pool(0, [1, 2, 3]) == [0, 0, 0]
