from __future__ import annotations

from datetime import timedelta

from fastapi import APIRouter, Depends, status
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.dependencies import Principal, require_admin, require_enterprise
from app.auth.passwords import generate_api_key
from app.db.models.enterprise import Enterprise, EnterpriseApiKey, EnterpriseStatus
from app.db.models.job import Job, JobStatus
from app.db.session import get_session, transactional
from app.exceptions import ConflictError, NotFoundError
from app.schemas.enterprise import (
    ApiKeyCreate,
    ApiKeyCreated,
    ApiKeyPublic,
    EnterpriseCreate,
    EnterprisePublic,
    EnterpriseStats,
)
from app.utils.ids import new_ulid
from app.utils.time import utcnow

router = APIRouter(prefix="/enterprise", tags=["enterprise"])


@router.post("", response_model=EnterprisePublic, status_code=status.HTTP_201_CREATED)
async def create_enterprise(
    payload: EnterpriseCreate,
    session: AsyncSession = Depends(get_session),
    _: Principal = Depends(require_admin),
) -> EnterprisePublic:
    async with transactional(session):
        existing = (await session.execute(
            select(Enterprise).where(Enterprise.slug == payload.slug)
        )).scalar_one_or_none()
        if existing is not None:
            raise ConflictError("slug already taken").as_http()

        e = Enterprise(
            id=new_ulid(),
            name=payload.name,
            slug=payload.slug,
            status=EnterpriseStatus.active,
            contact_email=str(payload.contact_email),
            billing_email=str(payload.billing_email) if payload.billing_email else None,
            tax_id=payload.tax_id,
            allowed_workload_kinds=payload.allowed_workload_kinds,
            compliance_tier=payload.compliance_tier,
        )
        session.add(e)

    return EnterprisePublic.model_validate(e)


@router.get("/me", response_model=EnterprisePublic)
async def get_me(
    principal: Principal = Depends(require_enterprise),
) -> EnterprisePublic:
    return EnterprisePublic.model_validate(principal.enterprise)


@router.get("/me/stats", response_model=EnterpriseStats)
async def stats(
    principal: Principal = Depends(require_enterprise),
    session: AsyncSession = Depends(get_session),
) -> EnterpriseStats:
    e_id = principal.enterprise.id
    cutoff = utcnow() - timedelta(days=30)

    active = (await session.execute(
        select(func.count(Job.id)).where(
            Job.enterprise_id == e_id,
            Job.status.in_((JobStatus.queued, JobStatus.running, JobStatus.leasing)),
        )
    )).scalar_one() or 0

    completed = (await session.execute(
        select(func.count(Job.id)).where(
            Job.enterprise_id == e_id,
            Job.status == JobStatus.succeeded,
            Job.finished_at >= cutoff,
        )
    )).scalar_one() or 0

    spend = (await session.execute(
        select(func.coalesce(func.sum(Job.spent_cents), 0)).where(
            Job.enterprise_id == e_id,
            Job.finished_at >= cutoff,
        )
    )).scalar_one() or 0

    avg_runtime = (await session.execute(
        select(
            func.coalesce(
                func.avg(
                    func.extract("epoch", Job.finished_at - Job.started_at)
                ),
                0,
            )
        ).where(
            Job.enterprise_id == e_id,
            Job.status == JobStatus.succeeded,
            Job.finished_at >= cutoff,
        )
    )).scalar_one() or 0

    total_terminal = (await session.execute(
        select(func.count(Job.id)).where(
            Job.enterprise_id == e_id,
            Job.status.in_((JobStatus.succeeded, JobStatus.failed, JobStatus.timed_out)),
            Job.finished_at >= cutoff,
        )
    )).scalar_one() or 0
    success_rate = float(completed) / total_terminal if total_terminal else 0.0

    return EnterpriseStats(
        jobs_active=int(active),
        jobs_completed_30d=int(completed),
        spend_30d_cents=int(spend),
        avg_runtime_seconds_30d=float(avg_runtime),
        success_rate_30d=round(success_rate, 4),
    )


@router.post("/me/api-keys", response_model=ApiKeyCreated, status_code=status.HTTP_201_CREATED)
async def create_api_key(
    payload: ApiKeyCreate,
    principal: Principal = Depends(require_enterprise),
    session: AsyncSession = Depends(get_session),
) -> ApiKeyCreated:
    full, prefix, hashed = generate_api_key()
    expires = (
        utcnow() + timedelta(days=payload.expires_in_days)
        if payload.expires_in_days
        else None
    )
    async with transactional(session):
        record = EnterpriseApiKey(
            id=new_ulid(),
            enterprise_id=principal.enterprise.id,
            label=payload.label,
            key_prefix=prefix,
            key_hash=hashed,
            scopes=payload.scopes,
            expires_at=expires,
        )
        session.add(record)
    return ApiKeyCreated(
        id=record.id,
        label=record.label,
        api_key=full,
        key_prefix=prefix,
        scopes=record.scopes,
        expires_at=expires,
    )


@router.get("/me/api-keys", response_model=list[ApiKeyPublic])
async def list_api_keys(
    principal: Principal = Depends(require_enterprise),
    session: AsyncSession = Depends(get_session),
) -> list[ApiKeyPublic]:
    rows = (await session.execute(
        select(EnterpriseApiKey)
        .where(EnterpriseApiKey.enterprise_id == principal.enterprise.id)
        .order_by(EnterpriseApiKey.created_at.desc())
    )).scalars().all()
    return [ApiKeyPublic.model_validate(r) for r in rows]


@router.delete("/me/api-keys/{key_id}", status_code=status.HTTP_204_NO_CONTENT)
async def revoke_api_key(
    key_id: str,
    principal: Principal = Depends(require_enterprise),
    session: AsyncSession = Depends(get_session),
) -> None:
    async with transactional(session):
        rec = await session.get(EnterpriseApiKey, key_id, with_for_update=True)
        if rec is None or rec.enterprise_id != principal.enterprise.id:
            raise NotFoundError("api key not found").as_http()
        rec.is_active = False
        rec.revoked_at = utcnow()
