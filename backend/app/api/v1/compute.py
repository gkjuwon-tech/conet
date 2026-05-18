"""``/v1/compute/*`` — cluster-key authenticated compute submission.

This is the **only** path SDK consumers should hit to actually run work.
The flow is::

    em_cluster_<secret>  ──►  POST /v1/compute/run
                                    │
                                    ▼
                              Job (pinned to bound cluster)
                              + WorkUnits
                              + ClusterLease(cluster=bound, job=new)
                                    │
                                    ▼
                              dispatcher → devices → results

The bound cluster is reserved at purchase time (see
``POST /v1/enterprise/clusters/{id}/purchase``), so we never race with the
auto-leasing logic in :class:`JobDispatcher`.
"""

from __future__ import annotations

from datetime import timedelta
from typing import Any

from fastapi import APIRouter, Depends, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.dependencies import Principal, require_cluster_key
from app.crypto.chunker import (
    WorkChunk,
    _payload_hash,
    chunk_fhe_share,
    chunk_hashcrack_dict,
    chunk_hashcrack_range,
)
from app.db.models import Job, WorkUnit
from app.db.models.job import ClusterLease, JobKind, JobStatus
from app.db.session import get_session, transactional
from app.exceptions import (
    ConflictError,
    NotFoundError,
    PermissionError_,
    PricingError,
    WorkunitRejected,
)
from app.schemas.compute import ComputePayload, ComputeRunCreated, ComputeRunPublic
from app.schemas.job import HashCrackDictInput, HashCrackRangeInput, JobCancel
from app.services.isolation import enforce_inbound_payload
from app.utils.ids import job_handle, new_ulid, workunit_handle
from app.utils.time import utcnow


router = APIRouter(prefix="/compute", tags=["compute"])


# ─── helpers ───────────────────────────────────────────────────────────────


def _build_manifest(payload: ComputePayload) -> dict[str, Any]:
    if payload.hashcrack_range is not None:
        return {"kind": payload.kind.value, "spec": payload.hashcrack_range}
    if payload.hashcrack_dict is not None:
        return {"kind": payload.kind.value, "spec": payload.hashcrack_dict}
    if payload.fhe_share is not None:
        return {"kind": payload.kind.value, "spec": payload.fhe_share}
    if payload.raw_manifest is not None:
        return payload.raw_manifest
    raise WorkunitRejected("manifest empty")


def _iter_chunks(payload: ComputePayload):
    if payload.hashcrack_range is not None:
        spec = HashCrackRangeInput.model_validate(payload.hashcrack_range)
        yield from chunk_hashcrack_range(spec)
        return
    if payload.hashcrack_dict is not None:
        spec = HashCrackDictInput.model_validate(payload.hashcrack_dict)
        total = max(1, int(spec.chunk_size * 4))
        yield from chunk_hashcrack_dict(spec, total_words=total * 16)
        return
    if payload.fhe_share is not None:
        spec = payload.fhe_share
        yield from chunk_fhe_share(
            scheme=spec["scheme"],
            public_params_uri=spec["public_params_uri"],
            ciphertext_chunks_uri=spec["ciphertext_chunks_uri"],
            op=spec["op"],
            count=16,
        )
        return
    raw = payload.raw_manifest or {}
    chunks = raw.get("chunks") or [raw]
    for i, payload_chunk in enumerate(chunks):
        yield WorkChunk(
            sequence_no=i,
            payload=payload_chunk,
            payload_hash=_payload_hash(payload_chunk),
            expected_runtime_seconds=int(payload_chunk.get("expected_runtime_seconds", 60)),
            weight=float(payload_chunk.get("weight", 1.0)),
        )


def _run_output(job: Job) -> dict[str, Any]:
    """Aggregate completed workunit results into a single output blob.

    Each ``WorkUnit.final_result`` is collected into ``output.workunits``;
    the convenience field ``output.value`` is set to the first non-empty
    final_result so trivial single-chunk jobs feel like a normal RPC.
    """
    workunits = []
    value: dict[str, Any] | None = None
    for wu in job.workunits or []:
        result = wu.final_result or {}
        workunits.append(
            {
                "handle": wu.handle,
                "sequence_no": wu.sequence_no,
                "result_hash": wu.final_result_hash,
                "result": result,
            }
        )
        if value is None and result:
            value = result
    output: dict[str, Any] = {"workunits": workunits}
    if value is not None:
        output["value"] = value
    output["job_handle"] = job.handle
    return output


def _as_run(job: Job, *, cluster_id: str, max_budget_cents: int) -> ComputeRunPublic:
    return ComputeRunPublic(
        run_id=job.handle,
        job_id=job.id,
        job_handle=job.handle,
        cluster_id=cluster_id,
        status=job.status,
        label=job.title,
        kind=job.kind,
        workunit_total=job.workunit_total,
        workunit_completed=job.workunit_completed,
        workunit_failed=job.workunit_failed,
        spent_cents=job.spent_cents,
        max_budget_cents=max_budget_cents,
        max_runtime_seconds=job.max_runtime_seconds,
        submitted_at=job.submitted_at,
        started_at=job.started_at,
        finished_at=job.finished_at,
        output=_run_output(job)
        if job.status in (JobStatus.succeeded, JobStatus.failed, JobStatus.cancelled, JobStatus.timed_out)
        else {},
    )


# ─── endpoints ─────────────────────────────────────────────────────────────


@router.post("/run", response_model=ComputeRunCreated, status_code=status.HTTP_201_CREATED)
async def submit_run(
    payload: ComputePayload,
    principal: Principal = Depends(require_cluster_key),
    session: AsyncSession = Depends(get_session),
) -> ComputeRunCreated:
    """Submit a workload to the cluster the calling key was purchased for."""
    enterprise = principal.enterprise
    api_key = principal.api_key
    cluster = principal.bound_cluster
    assert enterprise is not None and api_key is not None and cluster is not None

    # Budget enforcement at the *key* level. The optional per-run cap is
    # applied first, then we check against the key's remaining budget.
    requested_cap = payload.max_budget_cents or api_key.max_budget_cents or 0
    if api_key.max_budget_cents and api_key.spent_cents >= api_key.max_budget_cents:
        raise PricingError(
            "cluster key budget exhausted — purchase a new key or top up"
        ).as_http()
    if (
        api_key.max_budget_cents
        and api_key.spent_cents + max(requested_cap, 100) > api_key.max_budget_cents
    ):
        raise PricingError(
            "this run would exceed the cluster key budget"
        ).as_http()

    raw_manifest = _build_manifest(payload)
    enforce_inbound_payload(
        job_kind=payload.kind,
        raw_payload=raw_manifest,
        isolation_policy={},
    )

    async with transactional(session):
        job = Job(
            id=new_ulid(),
            handle=job_handle(),
            enterprise_id=enterprise.id,
            kind=payload.kind,
            status=JobStatus.queued,
            title=payload.label,
            description=None,
            input_manifest=raw_manifest,
            isolation_policy={},
            target_cluster_count=1,
            target_h100_equivalent=cluster.h100_equivalent or 1.0,
            max_budget_cents=requested_cap or 100,
            max_runtime_seconds=payload.max_runtime_seconds,
            redundancy=payload.redundancy,
            consensus_threshold=0.66,
            submitted_at=utcnow(),
            callback_url=payload.callback_url,
            metadata_={
                "submitted_via": "compute.run",
                "cluster_key_id": api_key.id,
                "cluster_id": cluster.id,
            },
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

        # Pin the job to the cluster the caller already paid for — skip the
        # auto-lease auction. dispatcher.claim_next_unit() will find this
        # lease (it picks the newest open lease on a cluster).
        now = utcnow()
        lease = ClusterLease(
            id=new_ulid(),
            cluster_id=cluster.id,
            job_id=job.id,
            started_at=now,
            expected_end_at=now + timedelta(seconds=job.max_runtime_seconds),
            rate_usd_per_hour=cluster.price_usd_per_hour,
        )
        session.add(lease)
        job.status = JobStatus.running
        job.started_at = now
        job.deadline_at = now + timedelta(seconds=job.max_runtime_seconds)

        # Budget hold against the cluster key.
        api_key.spent_cents += requested_cap or 100
        api_key.last_used_at = now

    return ComputeRunCreated(
        run_id=job.handle,
        job_id=job.id,
        job_handle=job.handle,
        cluster_id=cluster.id,
        status=job.status.value,
        submitted_at=job.submitted_at,
    )


async def _resolve_run(
    session: AsyncSession,
    run_id: str,
    *,
    api_key_id: str,
    enterprise_id: str,
    cluster_id: str,
    with_for_update: bool = False,
) -> Job | None:
    """Look up a Job by id OR handle, scoped to the caller's enterprise."""
    opts = {"with_for_update": True} if with_for_update else {}
    job = await session.get(Job, run_id, **opts)
    if job is None:
        stmt = select(Job).where(Job.handle == run_id).limit(1)
        if with_for_update:
            stmt = stmt.with_for_update()
        job = (await session.execute(stmt)).scalar_one_or_none()
    if job is None:
        return None
    if job.enterprise_id != enterprise_id:
        return None
    if (job.metadata_ or {}).get("cluster_id") != cluster_id:
        return None
    return job


@router.get("/runs/{run_id}", response_model=ComputeRunPublic)
async def get_run(
    run_id: str,
    principal: Principal = Depends(require_cluster_key),
    session: AsyncSession = Depends(get_session),
) -> ComputeRunPublic:
    api_key = principal.api_key
    cluster = principal.bound_cluster
    enterprise = principal.enterprise
    assert api_key is not None and cluster is not None and enterprise is not None

    job = await _resolve_run(
        session,
        run_id,
        api_key_id=api_key.id,
        enterprise_id=enterprise.id,
        cluster_id=cluster.id,
    )
    if job is None:
        raise NotFoundError("run not found").as_http()
    return _as_run(job, cluster_id=cluster.id, max_budget_cents=api_key.max_budget_cents)


@router.post("/runs/{run_id}/cancel", response_model=ComputeRunPublic)
async def cancel_run(
    run_id: str,
    payload: JobCancel,
    principal: Principal = Depends(require_cluster_key),
    session: AsyncSession = Depends(get_session),
) -> ComputeRunPublic:
    api_key = principal.api_key
    cluster = principal.bound_cluster
    enterprise = principal.enterprise
    assert api_key is not None and cluster is not None and enterprise is not None

    async with transactional(session):
        job = await _resolve_run(
            session,
            run_id,
            api_key_id=api_key.id,
            enterprise_id=enterprise.id,
            cluster_id=cluster.id,
            with_for_update=True,
        )
        if job is None:
            raise NotFoundError("run not found").as_http()
        if job.status in (
            JobStatus.succeeded,
            JobStatus.failed,
            JobStatus.cancelled,
            JobStatus.timed_out,
        ):
            raise ConflictError("run already terminal").as_http()
        job.status = JobStatus.cancelled
        job.finished_at = utcnow()
        job.metadata_ = {**(job.metadata_ or {}), "cancel_reason": payload.reason}

    return _as_run(job, cluster_id=cluster.id, max_budget_cents=api_key.max_budget_cents)
