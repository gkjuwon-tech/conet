from __future__ import annotations

from fastapi import APIRouter, Depends
from sqlalchemy import and_, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.dependencies import Principal, require_enterprise
from app.db.models.cluster import Cluster, ClusterStatus
from app.db.session import get_session
from app.exceptions import NotFoundError
from app.schemas.cluster import ClusterCard, MarketplaceFilter, MarketplacePage
from app.schemas.marketplace import Quote, QuoteRequest
from app.services.pricing import quote_cluster_runtime

router = APIRouter(prefix="/marketplace", tags=["marketplace"])


@router.post("/search", response_model=MarketplacePage)
async def search_clusters(
    filt: MarketplaceFilter,
    session: AsyncSession = Depends(get_session),
    _: Principal = Depends(require_enterprise),
) -> MarketplacePage:
    where = [
        Cluster.status == ClusterStatus.available,
        Cluster.is_listed.is_(True),
    ]
    if filt.min_h100_equivalent is not None:
        where.append(Cluster.h100_equivalent >= filt.min_h100_equivalent)
    if filt.max_h100_equivalent is not None:
        where.append(Cluster.h100_equivalent <= filt.max_h100_equivalent)
    if filt.min_price_usd_hour is not None:
        where.append(Cluster.price_usd_per_hour >= filt.min_price_usd_hour)
    if filt.max_price_usd_hour is not None:
        where.append(Cluster.price_usd_per_hour <= filt.max_price_usd_hour)
    if filt.min_reliability is not None:
        where.append(Cluster.reliability_score >= filt.min_reliability)
    if filt.region_hint:
        where.append(Cluster.region_hint == filt.region_hint)

    sort_col = {
        "price_asc": Cluster.price_usd_per_hour.asc(),
        "price_desc": Cluster.price_usd_per_hour.desc(),
        "h100_desc": Cluster.h100_equivalent.desc(),
        "reliability_desc": Cluster.reliability_score.desc(),
        "newest": Cluster.created_at.desc(),
    }.get(filt.sort, Cluster.price_usd_per_hour.asc())

    stmt = select(Cluster).where(and_(*where)).order_by(sort_col).limit(filt.limit + 1)
    if filt.cursor:
        stmt = stmt.where(Cluster.sequence_no > int(filt.cursor))

    rows = (await session.execute(stmt)).scalars().all()
    items = rows[: filt.limit]
    next_cursor = str(items[-1].sequence_no) if len(rows) > filt.limit else None

    total_estimate = int((await session.execute(
        select(func.count(Cluster.id)).where(and_(*where))
    )).scalar_one() or 0)

    return MarketplacePage(
        items=[ClusterCard.model_validate(c) for c in items],
        next_cursor=next_cursor,
        total_estimate=total_estimate,
    )


@router.post("/quote", response_model=list[Quote])
async def quote(
    req: QuoteRequest,
    session: AsyncSession = Depends(get_session),
    _: Principal = Depends(require_enterprise),
) -> list[Quote]:
    rows = (await session.execute(
        select(Cluster).where(Cluster.id.in_(req.cluster_ids))
    )).scalars().all()
    if len(rows) != len(req.cluster_ids):
        raise NotFoundError("one or more clusters not found").as_http()

    out: list[Quote] = []
    for c in rows:
        q = quote_cluster_runtime(c, req.hours)
        out.append(
            Quote(
                cluster=ClusterCard.model_validate(c),
                hours=req.hours,
                usd_total=q["total_usd"],
                expected_h100_hours=q["expected_h100_hours"],
                confidence=min(1.0, c.reliability_score * 1.2),
            )
        )
    return out
