from __future__ import annotations

import hashlib
import secrets

from app.crypto.attestation import (
    issue_pow_challenge,
    verify_hmac_proof,
    verify_pow_response,
    hmac_proof,
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
