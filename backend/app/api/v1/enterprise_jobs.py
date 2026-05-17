"""Enterprise job submission and query endpoints."""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends, Query, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.dependencies import Principal, require_enterprise, require_scope
from app.db.models import Job
from app.db.session import get_session
from app.exceptions import NotFoundError
from app.schemas.job import JobDetail, JobPublic, JobSubmit
from app.services.bundling import DispatchOutcome

router = APIRouter(prefix="/enterprise/jobs", tags=["enterprise_jobs"])


@router.post("/submit", status_code=status.HTTP_201_CREATED, response_model=dict[str, Any])
async def submit_job(
    payload: JobSubmit,
    session: AsyncSession = Depends(get_session),
    principal: Principal = Depends(require_enterprise),
    _: Principal = Depends(require_scope("clusters:submit_job")),
) -> dict[str, Any]:
    """Submit a compute job to available clusters."""
    if not principal.enterprise:
        raise NotFoundError("enterprise not found").as_http()

    from datetime import datetime, timedelta, timezone
    from app.db.models.job import Job, JobStatus

    job = Job(
        enterprise_id=principal.enterprise.id,
        kind=payload.kind,
        title=payload.title or "",
        description=payload.description or "",
        target_cluster_count=payload.target_cluster_count,
        target_h100_equivalent=payload.target_h100_equivalent,
        max_budget_cents=payload.max_budget_cents,
        max_runtime_seconds=payload.max_runtime_seconds,
        redundancy=payload.redundancy,
        consensus_threshold=payload.consensus_threshold,
        input_manifest=payload.model_dump(exclude_unset=True),
        isolation_policy=payload.isolation_policy.model_dump(),
        output_manifest={},
        status=JobStatus.pending,
        submitted_at=datetime.now(timezone.utc),
        deadline_at=datetime.now(timezone.utc) + timedelta(seconds=payload.max_runtime_seconds),
        callback_url=payload.callback_url,
    )

    session.add(job)
    await session.flush()
    await session.refresh(job)

    return {
        "id": job.id,
        "handle": job.handle,
        "enterprise_id": job.enterprise_id,
        "kind": job.kind.value,
        "status": job.status.value,
        "title": job.title,
        "submitted_at": job.submitted_at.isoformat() if job.submitted_at else None,
    }


@router.get("", response_model=list[dict[str, Any]])
async def list_jobs(
    limit: int = Query(default=50, ge=1, le=200),
    status: str | None = Query(default=None),
    session: AsyncSession = Depends(get_session),
    principal: Principal = Depends(require_enterprise),
    _: Principal = Depends(require_scope("jobs:read")),
) -> list[dict[str, Any]]:
    """List jobs for this enterprise."""
    if not principal.enterprise:
        raise NotFoundError("enterprise not found").as_http()

    stmt = (
        select(Job)
        .where(Job.enterprise_id == principal.enterprise.id)
        .order_by(Job.submitted_at.desc())
        .limit(limit)
    )
    if status:
        stmt = stmt.where(Job.status == status)

    rows = (await session.execute(stmt)).scalars().all()
    return [
        {
            "id": j.id,
            "handle": j.handle,
            "enterprise_id": j.enterprise_id,
            "kind": j.kind.value,
            "status": j.status.value,
            "title": j.title,
            "target_h100_equivalent": j.target_h100_equivalent,
            "spent_cents": j.spent_cents,
            "submitted_at": j.submitted_at.isoformat() if j.submitted_at else None,
        }
        for j in rows
    ]


@router.get("/{job_id}", response_model=dict[str, Any])
async def get_job(
    job_id: str,
    session: AsyncSession = Depends(get_session),
    principal: Principal = Depends(require_enterprise),
    _: Principal = Depends(require_scope("jobs:read")),
) -> dict[str, Any]:
    """Get job details."""
    job = await session.get(Job, job_id)
    if job is None:
        raise NotFoundError("job not found").as_http()
    if job.enterprise_id != principal.enterprise.id:
        raise NotFoundError("job not found").as_http()

    return {
        "id": job.id,
        "handle": job.handle,
        "enterprise_id": job.enterprise_id,
        "kind": job.kind.value,
        "status": job.status.value,
        "title": job.title,
        "description": job.description,
        "target_cluster_count": job.target_cluster_count,
        "target_h100_equivalent": job.target_h100_equivalent,
        "max_budget_cents": job.max_budget_cents,
        "max_runtime_seconds": job.max_runtime_seconds,
        "spent_cents": job.spent_cents,
        "paid_to_users_cents": job.paid_to_users_cents,
        "platform_fee_cents": job.platform_fee_cents,
        "submitted_at": job.submitted_at.isoformat() if job.submitted_at else None,
        "started_at": job.started_at.isoformat() if job.started_at else None,
        "finished_at": job.finished_at.isoformat() if job.finished_at else None,
        "deadline_at": job.deadline_at.isoformat() if job.deadline_at else None,
        "input_manifest": job.input_manifest,
        "output_manifest": job.output_manifest,
    }
