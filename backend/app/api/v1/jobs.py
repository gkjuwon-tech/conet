from __future__ import annotations

from fastapi import APIRouter, Depends, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.dependencies import Principal, require_enterprise
from app.crypto.chunker import (
    chunk_fhe_share,
    chunk_hashcrack_dict,
    chunk_hashcrack_range,
)
from app.db.models import Job, WorkUnit
from app.db.models.job import JobKind, JobStatus
from app.db.session import get_session, transactional
from app.exceptions import (
    ConflictError,
    NotFoundError,
    PermissionError_,
    PricingError,
    WorkunitRejected,
)
from app.schemas.job import (
    JobCancel,
    JobDetail,
    JobPublic,
    JobSubmit,
    WorkUnitPublic,
)
from app.services.dispatcher import JobDispatcher
from app.services.isolation import enforce_inbound_payload
from app.services.settlement import SettlementEngine
from app.utils.ids import job_handle, new_ulid, workunit_handle
from app.utils.time import utcnow


router = APIRouter(prefix="/jobs", tags=["jobs"])


async def _resolve_job(
    session: AsyncSession, job_id_or_handle: str, *, with_for_update: bool = False
) -> Job | None:
    """Look up a Job by primary-key id, falling back to its public handle.

    The CLI's `em job list` shows the *handle* (e.g. ``job_01KR…``) which is
    not the same ULID as the row's primary key. Accepting both lets users
    paste either string at us without surprise.
    """
    opts = {"with_for_update": True} if with_for_update else {}
    job = await session.get(Job, job_id_or_handle, **opts)
    if job is not None:
        return job
    stmt = select(Job).where(Job.handle == job_id_or_handle).limit(1)
    if with_for_update:
        stmt = stmt.with_for_update()
    return (await session.execute(stmt)).scalar_one_or_none()


@router.post("", response_model=JobDetail, status_code=status.HTTP_201_CREATED)
async def submit_job(
    payload: JobSubmit,
    principal: Principal = Depends(require_enterprise),
    session: AsyncSession = Depends(get_session),
) -> JobDetail:
    enterprise = principal.enterprise

    if (
        enterprise.spend_cap_cents is not None
        and enterprise.monthly_spend_cents + payload.max_budget_cents > enterprise.spend_cap_cents
    ):
        raise PricingError("budget exceeds enterprise spend cap").as_http()

    raw_manifest = _build_manifest(payload)
    enforce_inbound_payload(
        job_kind=payload.kind,
        raw_payload=raw_manifest,
        isolation_policy=payload.isolation_policy.model_dump(),
    )

    async with transactional(session):
        job = Job(
            id=new_ulid(),
            handle=job_handle(),
            enterprise_id=enterprise.id,
            kind=payload.kind,
            status=JobStatus.queued,
            title=payload.title,
            description=payload.description,
            input_manifest=raw_manifest,
            isolation_policy=payload.isolation_policy.model_dump(),
            target_cluster_count=payload.target_cluster_count,
            target_h100_equivalent=payload.target_h100_equivalent,
            max_budget_cents=payload.max_budget_cents,
            max_runtime_seconds=payload.max_runtime_seconds,
            redundancy=payload.redundancy,
            consensus_threshold=payload.consensus_threshold,
            submitted_at=utcnow(),
            callback_url=payload.callback_url,
        )
        session.add(job)
        await session.flush()

        try:
            chunks = list(_iter_chunks(payload))
        except ValueError as e:
            raise WorkunitRejected(str(e)).as_http()
        if not chunks:
            raise WorkunitRejected("no workunits could be derived from manifest").as_http()

        for c in chunks:
            session.add(
                WorkUnit(
                    id=new_ulid(),
                    handle=workunit_handle(),
                    job_id=job.id,
                    sequence_no=c.sequence_no,
                    payload=c.payload,
                    payload_hash=c.payload_hash,
                    expected_runtime_seconds=c.expected_runtime_seconds,
                    weight=c.weight,
                    redundancy_required=payload.redundancy,
                )
            )
        job.workunit_total = len(chunks)

        dispatcher = JobDispatcher()
        await dispatcher.lease_clusters_for_job(session, job)

    return JobDetail.model_validate(job)


@router.get("", response_model=list[JobPublic])
async def list_jobs(
    principal: Principal = Depends(require_enterprise),
    session: AsyncSession = Depends(get_session),
    limit: int = 50,
    status_filter: str | None = None,
) -> list[JobPublic]:
    stmt = (
        select(Job)
        .where(Job.enterprise_id == principal.enterprise.id)
        .order_by(Job.submitted_at.desc().nullslast())
        .limit(limit)
    )
    if status_filter:
        stmt = stmt.where(Job.status == status_filter)
    rows = (await session.execute(stmt)).scalars().all()
    return [JobPublic.model_validate(j) for j in rows]


@router.get("/{job_id}", response_model=JobDetail)
async def get_job(
    job_id: str,
    principal: Principal = Depends(require_enterprise),
    session: AsyncSession = Depends(get_session),
) -> JobDetail:
    job = await _resolve_job(session, job_id)
    if job is None:
        raise NotFoundError("job not found").as_http()
    if job.enterprise_id != principal.enterprise.id and not principal.is_admin:
        raise PermissionError_("not your job").as_http()
    return JobDetail.model_validate(job)


@router.get("/{job_id}/workunits", response_model=list[WorkUnitPublic])
async def list_workunits(
    job_id: str,
    principal: Principal = Depends(require_enterprise),
    session: AsyncSession = Depends(get_session),
    limit: int = 200,
) -> list[WorkUnitPublic]:
    job = await _resolve_job(session, job_id)
    if job is None:
        raise NotFoundError("job not found").as_http()
    if job.enterprise_id != principal.enterprise.id and not principal.is_admin:
        raise PermissionError_("not your job").as_http()

    rows = (await session.execute(
        select(WorkUnit).where(WorkUnit.job_id == job.id).order_by(WorkUnit.sequence_no).limit(limit)
    )).scalars().all()
    return [WorkUnitPublic.model_validate(w) for w in rows]


@router.post("/{job_id}/cancel", response_model=JobPublic)
async def cancel_job(
    job_id: str,
    payload: JobCancel,
    principal: Principal = Depends(require_enterprise),
    session: AsyncSession = Depends(get_session),
) -> JobPublic:
    async with transactional(session):
        job = await _resolve_job(session, job_id, with_for_update=True)
        if job is None:
            raise NotFoundError("job not found").as_http()
        if job.enterprise_id != principal.enterprise.id and not principal.is_admin:
            raise PermissionError_("not your job").as_http()
        if job.status in (JobStatus.succeeded, JobStatus.failed, JobStatus.cancelled):
            raise ConflictError("job already terminal").as_http()
        job.status = JobStatus.cancelled
        job.finished_at = utcnow()
        job.metadata_ = {**(job.metadata_ or {}), "cancel_reason": payload.reason}
    return JobPublic.model_validate(job)


@router.post("/{job_id}/finalize", response_model=JobPublic)
async def finalize_job(
    job_id: str,
    principal: Principal = Depends(require_enterprise),
    session: AsyncSession = Depends(get_session),
) -> JobPublic:
    job = await _resolve_job(session, job_id)
    if job is None:
        raise NotFoundError("job not found").as_http()
    if job.enterprise_id != principal.enterprise.id and not principal.is_admin:
        raise PermissionError_("not your job").as_http()

    engine = SettlementEngine()
    await engine.finalize_job(session, job.id)
    refreshed = await session.get(Job, job.id)
    return JobPublic.model_validate(refreshed)


def _build_manifest(payload: JobSubmit) -> dict:
    if payload.hashcrack_range is not None:
        return {"kind": payload.kind.value, "spec": payload.hashcrack_range.model_dump()}
    if payload.hashcrack_dict is not None:
        return {"kind": payload.kind.value, "spec": payload.hashcrack_dict.model_dump()}
    if payload.fhe_share is not None:
        return {"kind": payload.kind.value, "spec": payload.fhe_share.model_dump()}
    if payload.raw_manifest is not None:
        return payload.raw_manifest
    raise WorkunitRejected("manifest empty")


def _iter_chunks(payload: JobSubmit):
    if payload.hashcrack_range is not None:
        yield from chunk_hashcrack_range(payload.hashcrack_range)
        return
    if payload.hashcrack_dict is not None:
        total = max(1, int(payload.hashcrack_dict.chunk_size * 4))
        yield from chunk_hashcrack_dict(payload.hashcrack_dict, total_words=total * 16)
        return
    if payload.fhe_share is not None:
        count = max(1, payload.target_cluster_count)
        yield from chunk_fhe_share(
            scheme=payload.fhe_share.scheme,
            public_params_uri=payload.fhe_share.public_params_uri,
            ciphertext_chunks_uri=payload.fhe_share.ciphertext_chunks_uri,
            op=payload.fhe_share.op,
            count=count * 16,
        )
        return
    raw = payload.raw_manifest or {}
    chunks = raw.get("chunks", [])
    for i, payload_chunk in enumerate(chunks):
        from app.crypto.chunker import WorkChunk, _payload_hash  # type: ignore

        yield WorkChunk(
            sequence_no=i,
            payload=payload_chunk,
            payload_hash=_payload_hash(payload_chunk),
            expected_runtime_seconds=int(payload_chunk.get("expected_runtime_seconds", 60)),
            weight=float(payload_chunk.get("weight", 1.0)),
        )
