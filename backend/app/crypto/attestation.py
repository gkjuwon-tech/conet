from __future__ import annotations

import hashlib
import hmac
import secrets
from dataclasses import dataclass

from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import padding, rsa


@dataclass(slots=True)
class Challenge:
    challenge_id: str
    nonce: str
    issued_at_ms: int
    difficulty: int


def issue_pow_challenge(difficulty: int = 18) -> Challenge:
    return Challenge(
        challenge_id=secrets.token_hex(8),
        nonce=secrets.token_hex(24),
        issued_at_ms=_now_ms(),
        difficulty=max(8, min(28, difficulty)),
    )


def verify_pow_response(challenge: Challenge, candidate: str) -> bool:
    digest = hashlib.sha256(f"{challenge.nonce}:{candidate}".encode("utf-8")).digest()
    bits_needed = challenge.difficulty
    full_bytes, remainder = divmod(bits_needed, 8)
    if any(b != 0 for b in digest[:full_bytes]):
        return False
    if remainder and (digest[full_bytes] >> (8 - remainder)) != 0:
        return False
    return True


def verify_signed_attestation(
    public_key_pem: str, challenge_nonce: str, signature_hex: str
) -> bool:
    try:
        pub = serialization.load_pem_public_key(public_key_pem.encode("utf-8"))
    except Exception:
        return False

    if not isinstance(pub, rsa.RSAPublicKey):
        return False

    try:
        pub.verify(
            bytes.fromhex(signature_hex),
            challenge_nonce.encode("utf-8"),
            padding.PKCS1v15(),
            hashes.SHA256(),
        )
        return True
    except (InvalidSignature, ValueError):
        return False


def hmac_proof(secret: str, payload: str) -> str:
    return hmac.new(secret.encode("utf-8"), payload.encode("utf-8"), hashlib.sha256).hexdigest()


def verify_hmac_proof(secret: str, payload: str, proof: str) -> bool:
    return hmac.compare_digest(hmac_proof(secret, payload), proof)


def _now_ms() -> int:
    import time

    return int(time.time() * 1000)
