from __future__ import annotations

import time
from dataclasses import dataclass, field
from typing import Any, Literal

import jwt

from app.config import get_settings
from app.exceptions import AuthError

PrincipalKind = Literal["user", "device", "enterprise", "admin", "service"]


@dataclass(slots=True)
class TokenClaims:
    sub: str
    kind: PrincipalKind
    scope: list[str] = field(default_factory=list)
    enterprise_id: str | None = None
    device_id: str | None = None
    iat: int = 0
    exp: int = 0
    jti: str | None = None
    extra: dict[str, Any] = field(default_factory=dict)

    def has_scope(self, *required: str) -> bool:
        return all(r in self.scope for r in required)


def mint_token(
    *,
    sub: str,
    kind: PrincipalKind,
    scope: list[str] | None = None,
    enterprise_id: str | None = None,
    device_id: str | None = None,
    ttl_seconds: int | None = None,
    jti: str | None = None,
    extra: dict[str, Any] | None = None,
) -> tuple[str, int]:
    settings = get_settings()
    now = int(time.time())
    if ttl_seconds is None:
        ttl_seconds = {
            "user": settings.jwt_user_ttl_seconds,
            "admin": settings.jwt_user_ttl_seconds,
            "device": settings.jwt_device_ttl_seconds,
            "enterprise": settings.jwt_enterprise_ttl_seconds,
            "service": settings.jwt_user_ttl_seconds,
        }[kind]

    payload: dict[str, Any] = {
        "sub": sub,
        "kind": kind,
        "scope": scope or [],
        "iat": now,
        "exp": now + ttl_seconds,
        "iss": settings.service_name,
    }
    if enterprise_id:
        payload["enterprise_id"] = enterprise_id
    if device_id:
        payload["device_id"] = device_id
    if jti:
        payload["jti"] = jti
    if extra:
        payload["extra"] = extra

    token = jwt.encode(
        payload,
        settings.jwt_secret.get_secret_value(),
        algorithm=settings.jwt_alg,
    )
    return token, payload["exp"] - now


def decode_token(token: str) -> TokenClaims:
    settings = get_settings()
    try:
        decoded = jwt.decode(
            token,
            settings.jwt_secret.get_secret_value(),
            algorithms=[settings.jwt_alg],
            issuer=settings.service_name,
        )
    except jwt.ExpiredSignatureError as exc:
        raise AuthError("token expired") from exc
    except jwt.InvalidTokenError as exc:
        raise AuthError("invalid token") from exc

    return TokenClaims(
        sub=decoded["sub"],
        kind=decoded["kind"],
        scope=decoded.get("scope") or [],
        enterprise_id=decoded.get("enterprise_id"),
        device_id=decoded.get("device_id"),
        iat=int(decoded.get("iat", 0)),
        exp=int(decoded.get("exp", 0)),
        jti=decoded.get("jti"),
        extra=decoded.get("extra") or {},
    )
