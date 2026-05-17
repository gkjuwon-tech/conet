"""Enterprise API key management endpoints."""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Any

from fastapi import APIRouter, Depends, Query, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.dependencies import Principal, require_enterprise, require_scope
from app.auth.enterprise_scopes import validate_scopes
from app.auth.passwords import generate_api_key
from app.db.models import EnterpriseApiKey
from app.db.session import get_session
from app.exceptions import NotFoundError, ValidationError_
from app.schemas.enterprise import ApiKeyCreate, ApiKeyCreated, ApiKeyPublic

router = APIRouter(prefix="/enterprise/api-keys", tags=["enterprise_api_keys"])


@router.post("", status_code=status.HTTP_201_CREATED, response_model=dict[str, Any])
async def create_api_key(
    payload: ApiKeyCreate,
    session: AsyncSession = Depends(get_session),
    principal: Principal = Depends(require_enterprise),
    _: Principal = Depends(require_scope("clusters:manage_keys")),
) -> dict[str, Any]:
    """Create a new API key for this enterprise."""
    if not principal.enterprise:
        raise NotFoundError("enterprise not found").as_http()

    if not validate_scopes(payload.scopes):
        raise ValidationError_("invalid scopes").as_http()

    full_key, key_prefix, key_hash = generate_api_key(prefix="ent_prod")

    expires_at = None
    if payload.expires_in_days:
        expires_at = datetime.now(timezone.utc) + timedelta(days=payload.expires_in_days)

    api_key = EnterpriseApiKey(
        enterprise_id=principal.enterprise.id,
        label=payload.label,
        key_prefix=key_prefix,
        key_hash=key_hash,
        scopes=payload.scopes,
        expires_at=expires_at,
        is_active=True,
    )

    session.add(api_key)
    await session.flush()
    await session.refresh(api_key)

    return {
        "id": api_key.id,
        "label": api_key.label,
        "api_key": full_key,
        "key_prefix": api_key.key_prefix,
        "scopes": api_key.scopes,
        "expires_at": expires_at.isoformat() if expires_at else None,
    }


@router.get("", response_model=list[dict[str, Any]])
async def list_api_keys(
    limit: int = Query(default=50, ge=1, le=200),
    session: AsyncSession = Depends(get_session),
    principal: Principal = Depends(require_enterprise),
    _: Principal = Depends(require_scope("clusters:manage_keys")),
) -> list[dict[str, Any]]:
    """List API keys for this enterprise (masked secrets)."""
    if not principal.enterprise:
        raise NotFoundError("enterprise not found").as_http()

    stmt = (
        select(EnterpriseApiKey)
        .where(EnterpriseApiKey.enterprise_id == principal.enterprise.id)
        .order_by(EnterpriseApiKey.id.desc())
        .limit(limit)
    )

    rows = (await session.execute(stmt)).scalars().all()

    def mask_key_prefix(prefix: str) -> str:
        """Show only last 8 chars of key prefix for security."""
        if len(prefix) > 8:
            return f"...{prefix[-8:]}"
        return prefix

    return [
        {
            "id": k.id,
            "label": k.label,
            "key_prefix": mask_key_prefix(k.key_prefix),
            "scopes": k.scopes,
            "last_used_at": k.last_used_at.isoformat() if k.last_used_at else None,
            "revoked_at": k.revoked_at.isoformat() if k.revoked_at else None,
            "expires_at": k.expires_at.isoformat() if k.expires_at else None,
            "is_active": k.is_active,
        }
        for k in rows
    ]


@router.post("/{key_id}/revoke", status_code=status.HTTP_204_NO_CONTENT)
async def revoke_api_key(
    key_id: str,
    reason: str | None = Query(default=None, max_length=512),
    session: AsyncSession = Depends(get_session),
    principal: Principal = Depends(require_enterprise),
    _: Principal = Depends(require_scope("clusters:manage_keys")),
) -> None:
    """Revoke an API key."""
    if not principal.enterprise:
        raise NotFoundError("enterprise not found").as_http()

    api_key = await session.get(EnterpriseApiKey, key_id)
    if api_key is None or api_key.enterprise_id != principal.enterprise.id:
        raise NotFoundError("api key not found").as_http()

    api_key.revoked_at = datetime.now(timezone.utc)
    api_key.is_active = False
    await session.flush()
