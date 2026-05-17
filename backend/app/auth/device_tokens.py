from __future__ import annotations

import hashlib
import secrets
from dataclasses import dataclass

from app.utils.ids import short_token


@dataclass(slots=True)
class PairingPayload:
    code: str
    challenge: str
    expires_in: int


def generate_pairing_code() -> str:
    alphabet = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"
    return "".join(secrets.choice(alphabet) for _ in range(8))


def generate_attestation_challenge() -> str:
    return short_token(32)


def hash_pairing_code(code: str, salt: str) -> str:
    return hashlib.sha256(f"{salt}:{code.upper()}".encode("utf-8")).hexdigest()


def derive_device_secret(device_id: str, owner_id: str, master: str) -> str:
    return hashlib.sha256(f"{device_id}|{owner_id}|{master}".encode("utf-8")).hexdigest()
