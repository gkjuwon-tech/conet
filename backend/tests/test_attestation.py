from __future__ import annotations

import hashlib
import secrets

import pytest
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ed25519, padding, rsa

from app.crypto.attestation import (
    hmac_proof,
    issue_pow_challenge,
    verify_hmac_proof,
    verify_pow_response,
    verify_signed_attestation,
)


def test_pow_challenge_round_trip() -> None:
    ch = issue_pow_challenge(difficulty=8)
    candidate = "0"
    while True:
        digest = hashlib.sha256(f"{ch.nonce}:{candidate}".encode("utf-8")).digest()
        if digest[0] == 0:
            break
        candidate = secrets.token_hex(2)
    assert verify_pow_response(ch, candidate)


def test_hmac_proof_round_trip() -> None:
    secret = "shhh"
    payload = "workunit-result-hash"
    proof = hmac_proof(secret, payload)
    assert verify_hmac_proof(secret, payload, proof)
    assert not verify_hmac_proof(secret, payload + "x", proof)


# ── signed_attestation: PSS, PKCS1v15 fallback, Ed25519 ────────────────


def _pub_pem(key) -> str:
    return key.public_key().public_bytes(
        serialization.Encoding.PEM,
        serialization.PublicFormat.SubjectPublicKeyInfo,
    ).decode("utf-8")


def _rsa_key():
    return rsa.generate_private_key(public_exponent=65537, key_size=2048)


def test_signed_attestation_rsa_pss_round_trip() -> None:
    """The preferred path — RSA-PSS / SHA-256 / MGF1."""
    key = _rsa_key()
    nonce = "abc-123"
    sig = key.sign(
        nonce.encode("utf-8"),
        padding.PSS(
            mgf=padding.MGF1(hashes.SHA256()),
            salt_length=padding.PSS.DIGEST_LENGTH,
        ),
        hashes.SHA256(),
    )
    assert verify_signed_attestation(_pub_pem(key), nonce, sig.hex())


def test_signed_attestation_rsa_pkcs1v15_fallback_still_accepted() -> None:
    """Legacy signer — must still work so unupgraded devices can attest."""
    key = _rsa_key()
    nonce = "old-firmware"
    sig = key.sign(
        nonce.encode("utf-8"),
        padding.PKCS1v15(),
        hashes.SHA256(),
    )
    assert verify_signed_attestation(_pub_pem(key), nonce, sig.hex())


def test_signed_attestation_ed25519_round_trip() -> None:
    """Modern devices should ship with Ed25519."""
    key = ed25519.Ed25519PrivateKey.generate()
    nonce = "secure-nonce"
    sig = key.sign(nonce.encode("utf-8"))
    assert verify_signed_attestation(_pub_pem(key), nonce, sig.hex())


def test_signed_attestation_rejects_tampered_nonce() -> None:
    key = _rsa_key()
    sig = key.sign(
        b"original",
        padding.PSS(
            mgf=padding.MGF1(hashes.SHA256()),
            salt_length=padding.PSS.DIGEST_LENGTH,
        ),
        hashes.SHA256(),
    )
    assert not verify_signed_attestation(_pub_pem(key), "tampered", sig.hex())


def test_signed_attestation_rejects_wrong_key() -> None:
    signer = _rsa_key()
    other = _rsa_key()
    sig = signer.sign(
        b"hello",
        padding.PSS(
            mgf=padding.MGF1(hashes.SHA256()),
            salt_length=padding.PSS.DIGEST_LENGTH,
        ),
        hashes.SHA256(),
    )
    assert not verify_signed_attestation(_pub_pem(other), "hello", sig.hex())


@pytest.mark.parametrize("bad", ["", "zz", "not-hex"])
def test_signed_attestation_rejects_malformed_signature(bad: str) -> None:
    key = _rsa_key()
    assert not verify_signed_attestation(_pub_pem(key), "n", bad)
