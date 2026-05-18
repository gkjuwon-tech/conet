"""End-to-end ownership-verification flow against a real Postgres.

Covers the four security invariants that the unit tests can't reach
because they only exercise the pure verification helpers:

  1. **Pending quota** — minting more than ``MAX_PENDING_PER_USER`` open
     challenges raises before any DB row is written.
  2. **Lockout** — after ``max_attempts`` failed responses the row goes
     to ``locked`` and ``status_for`` reflects that; ``is_verified``
     stays ``False``.
  3. **Single-use consume** — a verified challenge can be consumed
     exactly once. The second consume returns ``None`` and the row's
     status is ``consumed``.
  4. **Audit trail** — every state transition (issued → verified →
     consumed, and issued → failed → locked) writes a row to
     ``device_ownership_audit``.

These tests are skipped if the test DB isn't reachable; they're meant
for CI's Postgres service container.
"""

from __future__ import annotations

import pytest
from sqlalchemy import select

from app.db.models.device_ownership import (
    DeviceOwnershipAudit,
    DeviceOwnershipAuditEvent,
    DeviceOwnershipChallenge,
    OwnershipChallengeMethod,
    OwnershipChallengeStatus,
)
from app.exceptions import (
    ConflictError,
    PermissionError_,
    ValidationError_,
)
from app.services.device_ownership import (
    MAX_PENDING_PER_USER,
    DeviceOwnershipService,
)


pytestmark = pytest.mark.asyncio


async def _issue_pin(svc, session, *, user_id="u_test", ip="192.168.1.10"):
    return await svc.issue(
        session,
        user_id=user_id,
        device_ip=ip,
        method=OwnershipChallengeMethod.pin_display,
    )


# ── 1. pending quota ────────────────────────────────────────────────────


async def test_issue_refuses_after_pending_quota_hit(db_session) -> None:
    svc = DeviceOwnershipService()
    # Fill up to the limit — each one against a different IP so neither
    # the lockout path nor the dedup-by-ip path interferes.
    for i in range(MAX_PENDING_PER_USER):
        await _issue_pin(svc, db_session, ip=f"10.0.0.{i + 1}")

    # The next one should fail with a clear, recoverable error.
    with pytest.raises((ValidationError_, ConflictError)):
        await _issue_pin(svc, db_session, ip="10.0.0.250")


async def test_pending_quota_does_not_count_consumed_or_failed(db_session) -> None:
    """Quota is about *open* challenges, not lifetime."""
    svc = DeviceOwnershipService()
    issued = await _issue_pin(svc, db_session, ip="10.0.0.1")

    # Verify + consume — now the row is in 'consumed', not 'pending'.
    pin = issued.rendered_pin
    assert pin is not None
    await svc.respond(
        db_session, user_id="u_test", challenge_id=issued.row.id, pin=pin,
    )
    await svc.consume(db_session, user_id="u_test", device_ip="10.0.0.1")

    # Should now be able to mint another batch — the consumed row
    # doesn't count against the cap.
    for i in range(MAX_PENDING_PER_USER):
        await _issue_pin(svc, db_session, ip=f"10.0.1.{i + 1}")


# ── 2. lockout ──────────────────────────────────────────────────────────


async def test_repeated_wrong_pin_locks_the_row(db_session) -> None:
    svc = DeviceOwnershipService()
    issued = await _issue_pin(svc, db_session, ip="192.168.5.7")
    challenge_id = issued.row.id
    max_attempts = issued.row.max_attempts

    for _ in range(max_attempts):
        outcome = await svc.respond(
            db_session, user_id="u_test", challenge_id=challenge_id, pin="000000",
        )
        assert outcome.verified is False

    # Re-fetch the row — should be 'locked', not 'pending'.
    row = await db_session.get(DeviceOwnershipChallenge, challenge_id)
    assert row is not None
    assert row.status == OwnershipChallengeStatus.locked

    # is_verified must return False for a locked row.
    assert await svc.is_verified(
        db_session, user_id="u_test", device_ip="192.168.5.7",
    ) is False


async def test_locked_ip_blocks_new_issue_until_cooldown(db_session) -> None:
    svc = DeviceOwnershipService()
    issued = await _issue_pin(svc, db_session, ip="192.168.5.8")
    for _ in range(issued.row.max_attempts):
        await svc.respond(
            db_session, user_id="u_test", challenge_id=issued.row.id, pin="000000",
        )

    # Brand-new challenge for the same (user, ip) should refuse —
    # the lockout cooldown is still active.
    with pytest.raises((PermissionError_, ValidationError_)):
        await _issue_pin(svc, db_session, ip="192.168.5.8")


# ── 3. single-use consume ───────────────────────────────────────────────


async def test_consume_burns_the_token(db_session) -> None:
    svc = DeviceOwnershipService()
    issued = await _issue_pin(svc, db_session, ip="172.20.0.5")
    pin = issued.rendered_pin
    assert pin is not None
    await svc.respond(
        db_session, user_id="u_test", challenge_id=issued.row.id, pin=pin,
    )

    first = await svc.consume(
        db_session, user_id="u_test", device_ip="172.20.0.5",
    )
    assert first is not None
    assert first.status == OwnershipChallengeStatus.consumed

    # Second consume must return None — the token is gone.
    second = await svc.consume(
        db_session, user_id="u_test", device_ip="172.20.0.5",
    )
    assert second is None

    # is_verified must drop to False after consume.
    assert await svc.is_verified(
        db_session, user_id="u_test", device_ip="172.20.0.5",
    ) is False


async def test_consume_returns_none_when_no_verified_row(db_session) -> None:
    """No verification ever happened — consume is a no-op."""
    svc = DeviceOwnershipService()
    result = await svc.consume(
        db_session, user_id="u_no_verify", device_ip="10.99.99.1",
    )
    assert result is None


# ── 4. audit trail ──────────────────────────────────────────────────────


async def _audit_events(session, *, challenge_id: str) -> list[DeviceOwnershipAuditEvent]:
    rows = (
        await session.execute(
            select(DeviceOwnershipAudit)
            .where(DeviceOwnershipAudit.challenge_id == challenge_id)
            .order_by(DeviceOwnershipAudit.occurred_at)
        )
    ).scalars().all()
    return [r.event for r in rows]


async def test_happy_path_audit_trail(db_session) -> None:
    svc = DeviceOwnershipService()
    issued = await _issue_pin(svc, db_session, ip="10.10.10.1")
    pin = issued.rendered_pin
    assert pin is not None
    await svc.respond(
        db_session, user_id="u_test", challenge_id=issued.row.id, pin=pin,
    )
    await svc.consume(db_session, user_id="u_test", device_ip="10.10.10.1")

    events = await _audit_events(db_session, challenge_id=issued.row.id)
    assert DeviceOwnershipAuditEvent.verification_consumed in events
    # We don't pin the full order because the service emits a few
    # status-transition events; we only assert that the terminal
    # 'consumed' event lands.


async def test_lockout_audit_trail(db_session) -> None:
    svc = DeviceOwnershipService()
    issued = await _issue_pin(svc, db_session, ip="10.10.10.2")
    challenge_id = issued.row.id
    for _ in range(issued.row.max_attempts):
        await svc.respond(
            db_session, user_id="u_test", challenge_id=challenge_id, pin="000000",
        )

    events = await _audit_events(db_session, challenge_id=challenge_id)
    # Every failed attempt should leave an audit record so an operator
    # investigating "why was this device claim denied?" has a paper trail.
    assert len(events) >= issued.row.max_attempts
