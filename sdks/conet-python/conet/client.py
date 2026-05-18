"""Conet enterprise control-plane API client.

This client is for **access keys** (``em_live_…``). For actually running
compute, use the cluster-key flow — see :mod:`conet.compute` for the
one-liner.

Usage::

    async with ConetClient(api_key="em_live_…") as client:
        clusters = await client.list_clusters(limit=10)
        result = await client.purchase_cluster(
            clusters[0]["id"],
            label="render-queue-prod",
            budget_cents=50_000,
        )
        # Store result["api_key"] immediately — it's shown exactly once.

The client is async-only on purpose — under any modern web framework
(FastAPI, Starlette, Sanic) you'll already be inside an event loop, and
``asyncio.run`` from inside a loop raises ``RuntimeError``. If you need
to call this from synchronous code, wrap a single call site with
``asyncio.run(client.list_clusters(...))`` yourself.
"""

from __future__ import annotations

from typing import Any

from conet._http import HttpClient

DEFAULT_BASE_URL = "https://api.electromesh.io"


class ConetClient:
    """Async client for Conet's enterprise control-plane API."""

    def __init__(
        self,
        api_key: str,
        *,
        base_url: str = DEFAULT_BASE_URL,
        timeout: float = 30.0,
        max_retries: int = 3,
    ) -> None:
        if not api_key:
            raise ValueError("api_key is required")
        if api_key.startswith("em_cluster_"):
            raise ValueError(
                "ConetClient takes an em_live_ access key; for compute use "
                "conet.compute.run() with your em_cluster_ key instead."
            )
        self.api_key = api_key
        self.base_url = base_url
        self._http = HttpClient(base_url, api_key, timeout=timeout, max_retries=max_retries)

    async def __aenter__(self) -> "ConetClient":
        return self

    async def __aexit__(self, *_exc: Any) -> None:
        await self.close()

    async def close(self) -> None:
        await self._http.close()

    # ── clusters / marketplace ────────────────────────────────────────

    async def list_clusters(
        self, *, limit: int = 50, status: str | None = None,
    ) -> list[dict[str, Any]]:
        """List clusters visible to this enterprise."""
        params: dict[str, Any] = {"limit": limit}
        if status:
            params["status"] = status
        return await self._http.get("/v1/clusters", params=params)

    async def get_cluster(self, cluster_id: str) -> dict[str, Any]:
        """Fetch cluster detail with anonymous member composition."""
        return await self._http.get(f"/v1/clusters/{cluster_id}")

    async def purchase_cluster(
        self,
        cluster_id: str,
        *,
        label: str,
        budget_cents: int,
        expires_in_days: int | None = None,
    ) -> dict[str, Any]:
        """Reserve a cluster and mint a fresh ``em_cluster_…`` key.

        The returned dict contains ``api_key`` — store it immediately.
        """
        body: dict[str, Any] = {"label": label, "budget_cents": budget_cents}
        if expires_in_days is not None:
            body["expires_in_days"] = expires_in_days
        return await self._http.post(
            f"/v1/enterprise/clusters/{cluster_id}/purchase", json=body
        )

    # ── jobs (legacy auto-lease flow) ─────────────────────────────────

    async def submit_job(self, job_spec: dict[str, Any]) -> dict[str, Any]:
        """Submit a job that auto-leases clusters (legacy flow).

        For workloads against a pre-purchased cluster, prefer
        :func:`conet.compute.run`.
        """
        return await self._http.post("/v1/jobs", json=job_spec)

    async def list_jobs(
        self, *, limit: int = 50, status: str | None = None,
    ) -> list[dict[str, Any]]:
        params: dict[str, Any] = {"limit": limit}
        if status:
            params["status_filter"] = status
        return await self._http.get("/v1/jobs", params=params)

    async def get_job(self, job_id: str) -> dict[str, Any]:
        return await self._http.get(f"/v1/jobs/{job_id}")

    async def cancel_job(self, job_id: str, reason: str | None = None) -> dict[str, Any]:
        return await self._http.post(
            f"/v1/jobs/{job_id}/cancel", json={"reason": reason} if reason else {},
        )

    # ── api key management ────────────────────────────────────────────

    async def create_api_key(
        self,
        label: str,
        *,
        scopes: list[str] | None = None,
        expires_in_days: int | None = None,
    ) -> dict[str, Any]:
        """Create a new **access** key. The plaintext key is shown once.

        To mint a *cluster* key, use :meth:`purchase_cluster` instead.
        """
        payload: dict[str, Any] = {
            "label": label,
            "scopes": scopes or ["clusters:read", "clusters:submit_job", "jobs:read"],
        }
        if expires_in_days is not None:
            payload["expires_in_days"] = expires_in_days
        return await self._http.post("/v1/enterprise/me/api-keys", json=payload)

    async def list_api_keys(
        self, *, kind: str | None = None
    ) -> list[dict[str, Any]]:
        """List API keys for the calling enterprise.

        Pass ``kind="access"`` or ``kind="cluster"`` to filter.
        """
        params: dict[str, Any] = {}
        if kind in ("access", "cluster"):
            params["kind"] = kind
        return await self._http.get("/v1/enterprise/me/api-keys", params=params or None)

    async def list_cluster_keys(self) -> list[dict[str, Any]]:
        """Convenience wrapper around ``list_api_keys(kind='cluster')``."""
        return await self._http.get("/v1/enterprise/me/cluster-keys")

    async def revoke_api_key(self, key_id: str, *, reason: str | None = None) -> None:
        body = {"reason": reason} if reason else None
        await self._http.delete(f"/v1/enterprise/me/api-keys/{key_id}", json=body)

    async def revoke_cluster_key(self, key_id: str) -> None:
        """Revoke a cluster key — releases the reserved cluster back to the pool."""
        await self._http.delete(f"/v1/enterprise/me/cluster-keys/{key_id}")
