"""Conet enterprise cluster compute API client.

Usage:
    async with ConetClient(api_key="ent_prod_…") as client:
        clusters = await client.list_clusters(limit=10)
        job = await client.submit_job({...})
        result = await client.get_job(job["id"])

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
    """Async client for Conet's enterprise compute API."""

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
        self.api_key = api_key
        self.base_url = base_url
        self._http = HttpClient(base_url, api_key, timeout=timeout, max_retries=max_retries)

    async def __aenter__(self) -> "ConetClient":
        return self

    async def __aexit__(self, *_exc: Any) -> None:
        await self.close()

    async def close(self) -> None:
        await self._http.close()

    # ── clusters ──────────────────────────────────────────────────────

    async def list_clusters(
        self, *, limit: int = 50, status: str | None = None,
    ) -> list[dict[str, Any]]:
        """List available clusters in the marketplace."""
        params: dict[str, Any] = {"limit": limit}
        if status:
            params["status"] = status
        return await self._http.get("/v1/enterprise/clusters", params=params)

    async def get_cluster(self, cluster_id: str) -> dict[str, Any]:
        """Fetch cluster detail with anonymous member composition."""
        return await self._http.get(f"/v1/enterprise/clusters/{cluster_id}")

    # ── jobs ──────────────────────────────────────────────────────────

    async def submit_job(self, job_spec: dict[str, Any]) -> dict[str, Any]:
        """Submit a compute job. See JobSubmit schema for required fields."""
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
        """Create a new API key for this enterprise. The plaintext key is
        only returned in this response — store it immediately."""
        payload: dict[str, Any] = {
            "label": label,
            "scopes": scopes or ["clusters:read", "clusters:submit_job"],
        }
        if expires_in_days is not None:
            payload["expires_in_days"] = expires_in_days
        return await self._http.post("/v1/enterprise/me/api-keys", json=payload)

    async def list_api_keys(self) -> list[dict[str, Any]]:
        return await self._http.get("/v1/enterprise/me/api-keys")

    async def revoke_api_key(self, key_id: str, *, reason: str | None = None) -> None:
        body = {"reason": reason} if reason else None
        await self._http.delete(f"/v1/enterprise/me/api-keys/{key_id}", json=body)
