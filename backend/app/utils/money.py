from __future__ import annotations

from decimal import ROUND_DOWN, ROUND_HALF_UP, Decimal


CENTS = Decimal("0.01")
MICRO = Decimal("0.000001")


def to_cents(amount_usd: Decimal | float | str) -> int:
    d = _D(amount_usd).quantize(CENTS, rounding=ROUND_HALF_UP)
    return int(d * 100)


def from_cents(cents: int) -> Decimal:
    return (Decimal(cents) / Decimal(100)).quantize(CENTS, rounding=ROUND_HALF_UP)


def split_pool(pool_cents: int, weights: list[float]) -> list[int]:
    if pool_cents <= 0 or not weights:
        return [0 for _ in weights]
    total = sum(weights)
    if total <= 0:
        return [0 for _ in weights]
    shares = [int(pool_cents * (w / total)) for w in weights]
    leftover = pool_cents - sum(shares)
    fractional = sorted(
        range(len(weights)),
        key=lambda i: -(pool_cents * (weights[i] / total) - shares[i]),
    )
    for i in fractional[:leftover]:
        shares[i] += 1
    return shares


def apply_bps(amount_cents: int, bps: int) -> int:
    return int(Decimal(amount_cents) * Decimal(bps) / Decimal(10_000))


def quantize_micro(value: Decimal | float) -> Decimal:
    return _D(value).quantize(MICRO, rounding=ROUND_DOWN)


def _D(v: Decimal | float | str | int) -> Decimal:
    if isinstance(v, Decimal):
        return v
    return Decimal(str(v))
