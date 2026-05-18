from __future__ import annotations

from datetime import timedelta

from fastapi import APIRouter, Depends, status
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.dependencies import (
    Principal,
    require_access_key,
    require_admin,
    require_enterprise,
)
from app.auth.enterprise_scopes import DEFAULT_CLUSTER_SCOPES, validate_scopes
from app.auth.passwords import generate_api_key
from app.db.models.cluster import Cluster, ClusterStatus
from app.db.models.enterprise import (
    Enterprise,
    EnterpriseApiKey,
    EnterpriseApiKeyKind,
    EnterpriseStatus,
)
from app.db.models.job import Job, JobStatus
from app.db.session import get_session, transactional
from app.exceptions import (
    ConflictError,
    NotFoundError,
    PermissionError_,
    PricingError,
    ValidationError_,
)
from app.schemas.enterprise import (
    ApiKeyCreate,
    ApiKeyCreated,
    ApiKeyPublic,
    ApiKeyRevoke,
    ClusterPurchase,
    ClusterPurchaseResult,
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


@router.post(
    "/me/api-keys",
    response_model=ApiKeyCreated,
    status_code=status.HTTP_201_CREATED,
)
@router.post(
    "/api-keys",
    response_model=ApiKeyCreated,
    status_code=status.HTTP_201_CREATED,
    include_in_schema=False,
)
async def create_api_key(
    payload: ApiKeyCreate,
    principal: Principal = Depends(require_access_key),
    session: AsyncSession = Depends(get_session),
) -> ApiKeyCreated:
    """Create a new **access** key (``em_live_…``).

    Cluster keys (``em_cluster_…``) are NOT minted here — use
    ``POST /v1/enterprise/clusters/{cluster_id}/purchase`` instead.
    """
    if not validate_scopes(payload.scopes, key_kind="access"):
        raise ValidationError_(
            "unknown scope — allowed access scopes: clusters:read, "
            "clusters:purchase, clusters:submit_job, clusters:manage_keys, jobs:read"
        ).as_http()

    full, prefix, hashed = generate_api_key(prefix="em_live")
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
            kind=EnterpriseApiKeyKind.access,
            expires_at=expires,
        )
        session.add(record)
    return ApiKeyCreated(
        id=record.id,
        label=record.label,
        api_key=full,
        key_prefix=prefix,
        scopes=record.scopes,
        kind=EnterpriseApiKeyKind.access,
        bound_cluster_id=None,
        expires_at=expires,
    )


@router.get("/me/api-keys", response_model=list[ApiKeyPublic])
@router.get("/api-keys", response_model=list[ApiKeyPublic], include_in_schema=False)
async def list_api_keys(
    principal: Principal = Depends(require_access_key),
    session: AsyncSession = Depends(get_session),
    kind: str | None = None,
) -> list[ApiKeyPublic]:
    """List api keys for the calling enterprise.

    Pass ``?kind=access`` or ``?kind=cluster`` to filter.
    """
    stmt = (
        select(EnterpriseApiKey)
        .where(EnterpriseApiKey.enterprise_id == principal.enterprise.id)
        .order_by(EnterpriseApiKey.created_at.desc())
    )
    if kind in ("access", "cluster"):
        stmt = stmt.where(EnterpriseApiKey.kind == EnterpriseApiKeyKind(kind))
    rows = (await session.execute(stmt)).scalars().all()
    return [ApiKeyPublic.model_validate(r) for r in rows]


@router.delete("/me/api-keys/{key_id}", status_code=status.HTTP_204_NO_CONTENT)
@router.delete(
    "/api-keys/{key_id}",
    status_code=status.HTTP_204_NO_CONTENT,
    include_in_schema=False,
)
async def revoke_api_key(
    key_id: str,
    payload: ApiKeyRevoke | None = None,
    principal: Principal = Depends(require_access_key),
    session: AsyncSession = Depends(get_session),
) -> None:
    """Revoke any API key (access or cluster) owned by the calling tenant.

    If the key was a *cluster* key with a reserved cluster, the cluster is
    released back to the pool.
    """
    async with transactional(session):
        rec = await session.get(EnterpriseApiKey, key_id, with_for_update=True)
        if rec is None or rec.enterprise_id != principal.enterprise.id:
            raise NotFoundError("api key not found").as_http()
        rec.is_active = False
        rec.revoked_at = utcnow()

        # If this was a cluster key, release the reserved cluster back to the
        # marketplace so other tenants can purchase it.
        if rec.kind == EnterpriseApiKeyKind.cluster and rec.bound_cluster_id:
            cluster = await session.get(
                Cluster, rec.bound_cluster_id, with_for_update=True
            )
            if cluster is not None:
                cluster.status = ClusterStatus.available
                meta = dict(cluster.metadata_ or {})
                meta.pop("reserved_by_enterprise_id", None)
                meta.pop("reserved_by_key_id", None)
                cluster.metadata_ = meta

        if payload and payload.reason:
            from app.db.models.audit import AuditEvent
            session.add(AuditEvent(
                id=new_ulid(),
                occurred_at=utcnow(),
                actor_kind="enterprise",
                actor_id=principal.enterprise.id,
                event_type="api_key.revoked",
                target_kind="enterprise_api_key",
                target_id=rec.id,
                severity="info",
                payload={
                    "reason": payload.reason,
                    "label": rec.label,
                    "kind": rec.kind.value,
                },
            ))


# ─── cluster purchase ─────────────────────────────────────────────────────────


@router.post(
    "/clusters/{cluster_id}/purchase",
    response_model=ClusterPurchaseResult,
    status_code=status.HTTP_201_CREATED,
)
async def purchase_cluster(
    cluster_id: str,
    payload: ClusterPurchase,
    principal: Principal = Depends(require_access_key),
    session: AsyncSession = Depends(get_session),
) -> ClusterPurchaseResult:
    """Reserve a cluster for the calling enterprise and mint a cluster API key.

    The returned ``em_cluster_…`` key is the **only** credential that can call
    ``POST /v1/compute/run`` against this cluster. It will be shown exactly
    once — store it immediately.
    """
    if principal.enterprise is None:
        raise PermissionError_("enterprise auth required").as_http()

    async with transactional(session):
        cluster = await session.get(Cluster, cluster_id, with_for_update=True)
        if cluster is None:
            raise NotFoundError("cluster not found").as_http()
        if cluster.status != ClusterStatus.available or not cluster.is_listed:
            raise ConflictError(
                f"cluster is not available for purchase (status={cluster.status.value})"
            ).as_http()

        enterprise = principal.enterprise
        # Spend cap check.
        if (
            enterprise.spend_cap_cents is not None
            and enterprise.monthly_spend_cents + payload.budget_cents
            > enterprise.spend_cap_cents
        ):
            raise PricingError(
                "budget exceeds enterprise monthly spend cap"
            ).as_http()
        if enterprise.credit_balance_cents < payload.budget_cents:
            raise PricingError(
                "insufficient credit balance — top up before purchase"
            ).as_http()

        # Hold the budget against the enterprise's credit balance up front
        # so two concurrent purchases can't both succeed against the same cents.
        enterprise.credit_balance_cents -= payload.budget_cents

        # Mint a cluster API key.
        full, prefix, hashed = generate_api_key(prefix="em_cluster")
        expires = (
            utcnow() + timedelta(days=payload.expires_in_days)
            if payload.expires_in_days
            else None
        )
        key = EnterpriseApiKey(
            id=new_ulid(),
            enterprise_id=enterprise.id,
            label=payload.label,
            key_prefix=prefix,
            key_hash=hashed,
            scopes=list(DEFAULT_CLUSTER_SCOPES),
            kind=EnterpriseApiKeyKind.cluster,
            bound_cluster_id=cluster.id,
            max_budget_cents=payload.budget_cents,
            spent_cents=0,
            expires_at=expires,
        )
        session.add(key)

        # Reserve the cluster.
        cluster.status = ClusterStatus.leased
        cluster.leased_at = utcnow()
        meta = dict(cluster.metadata_ or {})
        meta["reserved_by_enterprise_id"] = enterprise.id
        meta["reserved_by_key_id"] = key.id
        cluster.metadata_ = meta

    return ClusterPurchaseResult(
        id=key.id,
        label=key.label,
        api_key=full,
        key_prefix=prefix,
        bound_cluster_id=cluster.id,
        max_budget_cents=key.max_budget_cents,
        scopes=key.scopes,
        expires_at=expires,
    )


@router.get("/me/cluster-keys", response_model=list[ApiKeyPublic])
async def list_cluster_keys(
    principal: Principal = Depends(require_access_key),
    session: AsyncSession = Depends(get_session),
) -> list[ApiKeyPublic]:
    """List cluster (em_cluster_…) keys owned by the calling enterprise."""
    rows = (await session.execute(
        select(EnterpriseApiKey)
        .where(
            EnterpriseApiKey.enterprise_id == principal.enterprise.id,
            EnterpriseApiKey.kind == EnterpriseApiKeyKind.cluster,
        )
        .order_by(EnterpriseApiKey.created_at.desc())
    )).scalars().all()
    return [ApiKeyPublic.model_validate(r) for r in rows]


@router.delete(
    "/me/cluster-keys/{key_id}", status_code=status.HTTP_204_NO_CONTENT
)
async def revoke_cluster_key(
    key_id: str,
    principal: Principal = Depends(require_access_key),
    session: AsyncSession = Depends(get_session),
) -> None:
    """Revoke a cluster key and release the reserved cluster."""
    async with transactional(session):
        rec = await session.get(EnterpriseApiKey, key_id, with_for_update=True)
        if (
            rec is None
            or rec.enterprise_id != principal.enterprise.id
            or rec.kind != EnterpriseApiKeyKind.cluster
        ):
            raise NotFoundError("cluster key not found").as_http()
        rec.is_active = False
        rec.revoked_at = utcnow()
        if rec.bound_cluster_id:
            cluster = await session.get(
                Cluster, rec.bound_cluster_id, with_for_update=True
            )
            if cluster is not None:
                cluster.status = ClusterStatus.available
                meta = dict(cluster.metadata_ or {})
                meta.pop("reserved_by_enterprise_id", None)
                meta.pop("reserved_by_key_id", None)
                cluster.metadata_ = meta
