from __future__ import annotations

import hashlib
import hmac
import secrets

from passlib.context import CryptContext

_pwd_ctx = CryptContext(schemes=["bcrypt"], deprecated="auto", bcrypt__rounds=12)


def hash_password(password: str) -> str:
    return _pwd_ctx.hash(password)


def verify_password(password: str, hashed: str) -> bool:
    try:
        return _pwd_ctx.verify(password, hashed)
    except Exception:
        return False


def needs_rehash(hashed: str) -> bool:
    return _pwd_ctx.needs_update(hashed)


def generate_api_key(prefix: str = "em_live") -> tuple[str, str, str]:
    secret = secrets.token_urlsafe(36)
    full = f"{prefix}_{secret}"
    key_prefix = full[: len(prefix) + 9]
    key_hash = hashlib.sha256(full.encode("utf-8")).hexdigest()
    return full, key_prefix, key_hash


def hash_api_key(api_key: str) -> str:
    return hashlib.sha256(api_key.encode("utf-8")).hexdigest()


def constant_time_eq(a: str, b: str) -> bool:
    return hmac.compare_digest(a.encode("utf-8"), b.encode("utf-8"))
