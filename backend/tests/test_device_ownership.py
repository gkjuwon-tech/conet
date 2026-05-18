"""Tests for the device-ownership verification service.

Focused on the pure verification logic (PIN / MAC / attestation) that the
service uses to decide ``verified vs rejected``. The DB-backed pieces
(transactional row updates, audit logging) are exercised at the API
integration layer; this file pins down the security-critical helpers so
a regression here trips CI before it ever reaches production.
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

import pytest

from app.db.models.device_ownership import (
    DeviceOwnershipChallenge,
    OwnershipChallengeMethod,
    OwnershipChallengeStatus,
)
from app.services.device_ownership import DeviceOwnershipService

try:
    from cryptography.hazmat.primitives import hashes, serialization
    from cryptography.hazmat.primitives.asymmetric import padding, rsa
    HAS_CRYPTOGRAPHY = True
except Exception:  # pragma: no cover
    HAS_CRYPTOGRAPHY = False


def _make_row(
    *,
    method: OwnershipChallengeMethod,
    pin_hash: str | None = None,
    pin_salt: str | None = None,
    expected_mac: str | None = None,
    expected_serial: str | None = None,
    public_key_pem: str | None = None,
    nonce: str = "test-nonce",
) -> DeviceOwnershipChallenge:
    """Build an unpersisted challenge row for unit-test purposes."""
    row = DeviceOwnershipChallenge(
        id="01HXXXXXXXXXXXXXXXXXXXXXXX",
        user_id="user-test",
        device_ip="192.168.1.10",
        device_mac=None,
        expected_mac=expected_mac,
        expected_serial=expected_serial,
        method=method,
        status=OwnershipChallengeStatus.pending,
        nonce=nonce,
        pin_hash=pin_hash,
        pin_salt=pin_salt,
        public_key_pem=public_key_pem,
        expires_at=datetime.now(UTC) + timedelta(minutes=5),
        attempts=0,
        max_attempts=5,
        requester_ip=None,
        requester_user_agent=None,
        delivery={},
        metadata_={},
    )
    return row


# ── _canon_mac ─────────────────────────────────────────────────────────


def test_canon_mac_strips_separators_and_lowercases() -> None:
    svc = DeviceOwnershipService()
    assert svc._canon_mac("AA:BB:CC:DD:EE:FF") == "aabbccddeeff"
    assert svc._canon_mac("aa-bb-cc-dd-ee-ff") == "aabbccddeeff"
    assert svc._canon_mac("AABB.CCDD.EEFF") == "aabbccddeeff"
    assert svc._canon_mac("AABBCCDDEEFF") == "aabbccddeeff"


def test_canon_mac_handles_none() -> None:
    svc = DeviceOwnershipService()
    assert svc._canon_mac(None) is None


# ── _hash_pin ──────────────────────────────────────────────────────────


def test_hash_pin_is_deterministic_with_same_salt() -> None:
    svc = DeviceOwnershipService()
    h1 = svc._hash_pin("123456", "salt-a")
    h2 = svc._hash_pin("123456", "salt-a")
    assert h1 == h2


def test_hash_pin_changes_with_salt() -> None:
    svc = DeviceOwnershipService()
    h1 = svc._hash_pin("123456", "salt-a")
    h2 = svc._hash_pin("123456", "salt-b")
    assert h1 != h2


def test_hash_pin_changes_with_pin() -> None:
    svc = DeviceOwnershipService()
    h1 = svc._hash_pin("123456", "salt")
    h2 = svc._hash_pin("654321", "salt")
    assert h1 != h2


# ── PIN method ─────────────────────────────────────────────────────────


def test_pin_verify_accepts_correct_pin() -> None:
    svc = DeviceOwnershipService()
    salt = "fixed-salt"
    pin = "424242"
    row = _make_row(
        method=OwnershipChallengeMethod.pin_display,
        pin_hash=svc._hash_pin(pin, salt),
        pin_salt=salt,
    )
    ok, _ = svc._verify_payload(row, pin=pin, mac=None, serial=None, signature_hex=None)
    assert ok is True


def test_pin_verify_strips_whitespace() -> None:
    svc = DeviceOwnershipService()
    salt = "fixed-salt"
    pin = "424242"
    row = _make_row(
        method=OwnershipChallengeMethod.pin_display,
        pin_hash=svc._hash_pin(pin, salt),
        pin_salt=salt,
    )
    ok, _ = svc._verify_payload(
        row, pin="  424242  ", mac=None, serial=None, signature_hex=None,
    )
    assert ok is True


def test_pin_verify_rejects_wrong_pin() -> None:
    svc = DeviceOwnershipService()
    salt = "fixed-salt"
    row = _make_row(
        method=OwnershipChallengeMethod.pin_display,
        pin_hash=svc._hash_pin("424242", salt),
        pin_salt=salt,
    )
    ok, reason = svc._verify_payload(
        row, pin="123456", mac=None, serial=None, signature_hex=None,
    )
    assert ok is False
    assert "incorrect" in reason


def test_pin_verify_rejects_missing_pin() -> None:
    svc = DeviceOwnershipService()
    row = _make_row(
        method=OwnershipChallengeMethod.pin_display,
        pin_hash="x" * 64,
        pin_salt="salt",
    )
    ok, reason = svc._verify_payload(
        row, pin=None, mac=None, serial=None, signature_hex=None,
    )
    assert ok is False
    assert "missing pin" in reason


def test_pin_verify_rejects_when_row_has_no_material() -> None:
    svc = DeviceOwnershipService()
    row = _make_row(
        method=OwnershipChallengeMethod.pin_display,
        pin_hash=None,
        pin_salt=None,
    )
    ok, reason = svc._verify_payload(
        row, pin="424242", mac=None, serial=None, signature_hex=None,
    )
    assert ok is False
    assert "no pin material" in reason


# ── MAC / serial method ────────────────────────────────────────────────


def test_mac_verify_accepts_matching_mac_any_format() -> None:
    svc = DeviceOwnershipService()
    row = _make_row(
        method=OwnershipChallengeMethod.mac_serial,
        expected_mac=svc._canon_mac("AA:BB:CC:DD:EE:FF"),
    )
    for candidate in (
        "AA:BB:CC:DD:EE:FF",
        "aa-bb-cc-dd-ee-ff",
        "AABB.CCDD.EEFF",
        "aabbccddeeff",
    ):
        ok, _ = svc._verify_payload(
            row, pin=None, mac=candidate, serial=None, signature_hex=None,
        )
        assert ok is True, candidate


def test_mac_verify_rejects_wrong_mac() -> None:
    svc = DeviceOwnershipService()
    row = _make_row(
        method=OwnershipChallengeMethod.mac_serial,
        expected_mac=svc._canon_mac("AA:BB:CC:DD:EE:FF"),
    )
    ok, reason = svc._verify_payload(
        row, pin=None, mac="11:22:33:44:55:66", serial=None, signature_hex=None,
    )
    assert ok is False
    assert "mac" in reason


def test_mac_verify_requires_serial_when_set() -> None:
    svc = DeviceOwnershipService()
    row = _make_row(
        method=OwnershipChallengeMethod.mac_serial,
        expected_mac=svc._canon_mac("AA:BB:CC:DD:EE:FF"),
        expected_serial="ABC123",
    )
    # Missing serial — must reject.
    ok, reason = svc._verify_payload(
        row, pin=None, mac="aa:bb:cc:dd:ee:ff", serial=None, signature_hex=None,
    )
    assert ok is False
    assert "serial" in reason

    # Wrong serial — must reject.
    ok, reason = svc._verify_payload(
        row, pin=None, mac="aa:bb:cc:dd:ee:ff", serial="WRONG", signature_hex=None,
    )
    assert ok is False
    assert "serial" in reason

    # Case-insensitive match — must accept.
    ok, _ = svc._verify_payload(
        row, pin=None, mac="aa:bb:cc:dd:ee:ff", serial="abc123", signature_hex=None,
    )
    assert ok is True


def test_mac_verify_rejects_missing_mac() -> None:
    svc = DeviceOwnershipService()
    row = _make_row(
        method=OwnershipChallengeMethod.mac_serial,
        expected_mac="aabbccddeeff",
    )
    ok, reason = svc._verify_payload(
        row, pin=None, mac=None, serial=None, signature_hex=None,
    )
    assert ok is False
    assert "missing mac" in reason


def test_mac_verify_rejects_when_row_has_no_expected_mac() -> None:
    svc = DeviceOwnershipService()
    row = _make_row(
        method=OwnershipChallengeMethod.mac_serial,
        expected_mac=None,
    )
    ok, reason = svc._verify_payload(
        row, pin=None, mac="aa:bb:cc:dd:ee:ff", serial=None, signature_hex=None,
    )
    assert ok is False
    assert "expected mac" in reason


# ── signed_attestation method ──────────────────────────────────────────


def test_attestation_verify_rejects_when_no_signature() -> None:
    svc = DeviceOwnershipService()
    row = _make_row(
        method=OwnershipChallengeMethod.signed_attestation,
        public_key_pem="-----BEGIN PUBLIC KEY-----\nfake\n-----END PUBLIC KEY-----",
    )
    ok, reason = svc._verify_payload(
        row, pin=None, mac=None, serial=None, signature_hex=None,
    )
    assert ok is False
    assert "signature" in reason


def test_attestation_verify_rejects_malformed_signature() -> None:
    """A bogus signature must bubble up as ``False`` rather than 500."""
    svc = DeviceOwnershipService()
    row = _make_row(
        method=OwnershipChallengeMethod.signed_attestation,
        public_key_pem="-----BEGIN PUBLIC KEY-----\nnotrealpem\n-----END PUBLIC KEY-----",
    )
    ok, _ = svc._verify_payload(
        row, pin=None, mac=None, serial=None, signature_hex="deadbeef",
    )
    assert ok is False


@pytest.mark.skipif(not HAS_CRYPTOGRAPHY, reason="cryptography not installed")
def test_attestation_verify_accepts_valid_signature() -> None:
    """End-to-end: sign with a freshly generated RSA key, verify via _verify_payload."""
    sk = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    pk_pem = sk.public_key().public_bytes(
        encoding=serialization.Encoding.PEM,
        format=serialization.PublicFormat.SubjectPublicKeyInfo,
    ).decode()

    nonce = "challenge-nonce-abc123"
    signature_hex = sk.sign(
        nonce.encode(),
        padding.PKCS1v15(),
        hashes.SHA256(),
    ).hex()

    svc = DeviceOwnershipService()
    row = _make_row(
        method=OwnershipChallengeMethod.signed_attestation,
        public_key_pem=pk_pem,
        nonce=nonce,
    )
    ok, _ = svc._verify_payload(
        row, pin=None, mac=None, serial=None, signature_hex=signature_hex,
    )
    assert ok is True


@pytest.mark.skipif(not HAS_CRYPTOGRAPHY, reason="cryptography not installed")
def test_attestation_verify_rejects_wrong_nonce() -> None:
    """Signing a different nonce must NOT verify against the challenge nonce."""
    sk = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    pk_pem = sk.public_key().public_bytes(
        encoding=serialization.Encoding.PEM,
        format=serialization.PublicFormat.SubjectPublicKeyInfo,
    ).decode()

    signature_hex = sk.sign(
        b"different-nonce",
        padding.PKCS1v15(),
        hashes.SHA256(),
    ).hex()

    svc = DeviceOwnershipService()
    row = _make_row(
        method=OwnershipChallengeMethod.signed_attestation,
        public_key_pem=pk_pem,
        nonce="challenge-nonce-abc123",
    )
    ok, _ = svc._verify_payload(
        row, pin=None, mac=None, serial=None, signature_hex=signature_hex,
    )
    assert ok is False


# ── terminal-state guard on the model itself ──────────────────────────


def test_challenge_is_terminal_for_consumed_and_locked() -> None:
    row = _make_row(method=OwnershipChallengeMethod.pin_display)
    assert row.is_terminal is False
    row.status = OwnershipChallengeStatus.consumed
    assert row.is_terminal is True
    row.status = OwnershipChallengeStatus.locked
    assert row.is_terminal is True
    row.status = OwnershipChallengeStatus.expired
    assert row.is_terminal is True
    row.status = OwnershipChallengeStatus.cancelled
    assert row.is_terminal is True
    row.status = OwnershipChallengeStatus.verified
    assert row.is_terminal is False
