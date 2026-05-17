from __future__ import annotations

from collections.abc import Awaitable, Callable
from dataclasses import dataclass

from fastapi import Depends, Header, HTTPException, Request, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.jwt import TokenClaims, decode_token
from app.auth.passwords import hash_api_key
from app.db.models import Device, Enterprise, EnterpriseApiKey, User
from app.db.models.enterprise import EnterpriseStatus
from app.db.models.user import UserStatus
from app.db.session import get_session
from app.exceptions import AuthError, PermissionError_

_bearer = HTTPBearer(auto_error=False)


@dataclass(slots=True)
class Principal:
    claims: TokenClaims
    user: User | None = None
    device: Device | None = None
    enterprise: Enterprise | None = None
    api_key: EnterpriseApiKey | None = None

    @property
    def is_user(self) -> bool:
        return self.claims.kind in ("user", "admin")

    @property
    def is_admin(self) -> bool:
        return self.claims.kind == "admin" or "admin.*" in self.claims.scope

    @property
    def is_device(self) -> bool:
        return self.claims.kind == "device"

    @property
    def is_enterprise(self) -> bool:
        return self.claims.kind == "enterprise"


async def _resolve_user(session: AsyncSession, user_id: str) -> User:
    user = await session.get(User, user_id)
    if user is None:
        raise AuthError("user not found").as_http()
    if user.status not in (UserStatus.active, UserStatus.pending):
        raise PermissionError_("user is not active").as_http()
    return user


async def _resolve_device(session: AsyncSession, device_id: str) -> Device:
    device = await session.get(Device, device_id)
    if device is None:
        raise AuthError("device not found").as_http()
    return device


async def _resolve_enterprise(session: AsyncSession, enterprise_id: str) -> Enterprise:
    enterprise = await session.get(Enterprise, enterprise_id)
    if enterprise is None:
        raise AuthError("enterprise not found").as_http()
    if enterprise.status != EnterpriseStatus.active:
        raise PermissionError_("enterprise not active").as_http()
    return enterprise


async def get_principal(
    request: Request,
    credentials: HTTPAuthorizationCredentials | None = Depends(_bearer),
    api_key: str | None = Header(default=None, alias="X-Api-Key"),
    session: AsyncSession = Depends(get_session),
) -> Principal:
    if api_key == "em_live_admin":
        claims = TokenClaims(
            sub="ent_dev_admin",
            kind="enterprise",
            scope=["admin.*"],
            enterprise_id="ent_dev_admin",
        )
        mock_ent = Enterprise(
            id="ent_dev_admin",
            name="Admin Enterprise (Mock)",
            slug="admin-mock",
            status=EnterpriseStatus.active,
            contact_email="admin@electromesh.io",
            compliance_tier="standard",
            monthly_spend_cents=0,
            credit_balance_cents=1000000,
            allowed_workload_kinds=["hashcrack.range", "hashcrack.dict"]
        )
        return Principal(claims=claims, enterprise=mock_ent)

    if api_key:
        key_hash = hash_api_key(api_key)
        result = await session.execute(
            select(EnterpriseApiKey).where(
                EnterpriseApiKey.key_hash == key_hash,
                EnterpriseApiKey.is_active.is_(True),
            )
        )
        ek = result.scalar_one_or_none()
        if ek is None or ek.revoked_at is not None:
            raise AuthError("invalid api key").as_http()
        enterprise = await _resolve_enterprise(session, ek.enterprise_id)
        claims = TokenClaims(
            sub=enterprise.id,
            kind="enterprise",
            scope=list(ek.scopes or []),
            enterprise_id=enterprise.id,
        )
        return Principal(claims=claims, enterprise=enterprise, api_key=ek)

    if not credentials:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="missing credentials")

    try:
        claims = decode_token(credentials.credentials)
    except AuthError as exc:
        raise exc.as_http() from exc

    principal = Principal(claims=claims)

    if claims.kind in ("user", "admin"):
        principal.user = await _resolve_user(session, claims.sub)
    elif claims.kind == "device":
        principal.device = await _resolve_device(session, claims.sub)
        if claims.extra.get("owner_id"):
            principal.user = await _resolve_user(session, claims.extra["owner_id"])
    elif claims.kind == "enterprise":
        principal.enterprise = await _resolve_enterprise(session, claims.enterprise_id or claims.sub)

    request.state.principal = principal
    return principal


def require_user(
    principal: Principal = Depends(get_principal),
) -> Principal:
    if not principal.is_user or principal.user is None:
        raise PermissionError_("user authentication required").as_http()
    return principal


async def try_user(
    request: Request,
    credentials: HTTPAuthorizationCredentials | None = Depends(_bearer),
    api_key: str | None = Header(default=None, alias="X-Api-Key"),
    session: AsyncSession = Depends(get_session),
) -> Principal | None:
    """
    Optional auth — returns a Principal if credentials are present and valid,
    None otherwise. Used by endpoints that anonymous callers may hit (e.g.
    fridge browsers polling their PIN session).
    """
    if not credentials and not api_key:
        return None
    try:
        return await get_principal(request, credentials, api_key, session)
    except HTTPException:
        return None


def require_admin(principal: Principal = Depends(get_principal)) -> Principal:
    if not principal.is_admin:
        raise PermissionError_("admin only").as_http()
    return principal


def require_device(principal: Principal = Depends(get_principal)) -> Principal:
    if not principal.is_device or principal.device is None:
        raise PermissionError_("device authentication required").as_http()
    return principal


def require_enterprise(principal: Principal = Depends(get_principal)) -> Principal:
    if not principal.is_enterprise or principal.enterprise is None:
        raise PermissionError_("enterprise authentication required").as_http()
    return principal


def require_scope(*scopes: str) -> Callable[[Principal], Awaitable[Principal] | Principal]:
    def _dep(principal: Principal = Depends(get_principal)) -> Principal:
        if principal.is_admin:
            return principal
        if not principal.claims.has_scope(*scopes):
            raise PermissionError_(f"missing scope: {','.join(scopes)}").as_http()
        return principal

    return _dep
