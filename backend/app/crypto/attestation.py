from __future__ import annotations

import hashlib
import hmac
import secrets
from dataclasses import dataclass

from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ed25519, padding, rsa


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
    """Verify an attestation signature against the device's published public key.

    Accepts (in order of preference):
      1. Ed25519 — fixed-size, deterministic, no padding choices to misconfigure.
      2. RSA-PSS with SHA-256 / MGF1-SHA-256 / digest-length salt — modern default.
      3. RSA-PKCS1v15 — only here so devices that already shipped with the old
         signer can still attest while their next OTA migrates them off. New
         devices should never produce this signature shape.
    """
    try:
        pub = serialization.load_pem_public_key(public_key_pem.encode("utf-8"))
    except Exception:
        return False

    try:
        signature = bytes.fromhex(signature_hex)
    except ValueError:
        return False
    message = challenge_nonce.encode("utf-8")

    if isinstance(pub, ed25519.Ed25519PublicKey):
        try:
            pub.verify(signature, message)
            return True
        except InvalidSignature:
            return False

    if not isinstance(pub, rsa.RSAPublicKey):
        return False

    # PSS first (preferred). Fall back to PKCS1v15 only if PSS fails — keeps
    # older firmware compatible while the fleet rolls forward.
    try:
        pub.verify(
            signature,
            message,
            padding.PSS(
                mgf=padding.MGF1(hashes.SHA256()),
                salt_length=padding.PSS.DIGEST_LENGTH,
            ),
            hashes.SHA256(),
        )
        return True
    except (InvalidSignature, ValueError):
        pass

    try:
        pub.verify(
            signature,
            message,
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
