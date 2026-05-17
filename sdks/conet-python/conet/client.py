"""Conet enterprise cluster compute API client."""

from __future__ import annotations

import asyncio
from typing import Any, Optional

from conet._http import HttpClient


class ConetClient:
    """Simple enterprise cluster API client.

    Usage:
        async with ConetClient(api_key="ent_prod_...") as client:
            clusters = await client.list_clusters(limit=10)
            for cluster in clusters:
                print(f"{cluster['handle']}: {cluster['h100_equivalent']} H100eq")
    """

    def __init__(
        self,
        api_key: str,
        base_url: str = "https://api.electromesh.io",
        timeout: float = 30.0,
        max_retries: int = 3,
    ):
        """Initialize Conet client.

        Args:
            api_key: Enterprise API key (e.g., "ent_prod_...")
            base_url: API base URL (default: Conet production)
            timeout: Request timeout in seconds (default: 30)
            max_retries: Number of retries for transient failures (default: 3)
        """
        self.api_key = api_key
        self.base_url = base_url
        self.timeout = timeout
        self.max_retries = max_retries
        self._http = HttpClient(base_url, api_key, timeout, max_retries)

    async def close(self) -> None:
        """Close HTTP client."""
        await self._http.close()

    async def __aenter__(self) -> ConetClient:
        return self

    async def __aexit__(self, *args: Any) -> None:
        await self.close()

    async def list_clusters(
        self,
        limit: int = 50,
        status: Optional[str] = None,
    ) -> list[dict[str, Any]]:
        """List clusters available to this enterprise.

        Args:
            limit: Max clusters to return (default: 50, max: 200)
            status: Filter by status (e.g., "available", "leased")

        Returns:
            List of cluster cards with compute capacity info.
        """
        params = {"limit": limit}
        if status:
            params["status"] = status
        return await self._http.get("/v1/enterprise/clusters", params=params)

    async def get_cluster(self, cluster_id: str) -> dict[str, Any]:
        """Get detailed cluster info.

        Args:
            cluster_id: Cluster ID or handle

        Returns:
            Cluster detail with members (no device IDs or SSH endpoints).
        """
        return await self._http.get(f"/v1/enterprise/clusters/{cluster_id}")

    async def submit_job(self, job_spec: dict[str, Any]) -> dict[str, Any]:
        """Submit a compute job to available clusters.

        Args:
            job_spec: Job specification (see JobSubmit schema)

        Returns:
            Created job details with handle and status.

        Example:
            job = await client.submit_job({
                "kind": "hashcrack.range",
                "max_budget_cents": 10000,
                "hashcrack_range": {
                    "algorithm": "sha256",
                    "target_hash": "abc123...",
                    "charset": "0123456789abcdef",
                    "min_length": 6,
                    "max_length": 8,
                }
            })
        """
        return await self._http.post("/v1/enterprise/jobs/submit", json=job_spec)

    async def list_jobs(
        self,
        limit: int = 50,
        status: Optional[str] = None,
    ) -> list[dict[str, Any]]:
        """List jobs for this enterprise.

        Args:
            limit: Max jobs to return (default: 50, max: 200)
            status: Filter by status (e.g., "pending", "running", "completed")

        Returns:
            List of jobs with summary info.
        """
        params = {"limit": limit}
        if status:
            params["status"] = status
        return await self._http.get("/v1/enterprise/jobs", params=params)

    async def get_job(self, job_id: str) -> dict[str, Any]:
        """Get job details and status.

        Args:
            job_id: Job ID or handle

        Returns:
            Full job details with manifests and progress.
        """
        return await self._http.get(f"/v1/enterprise/jobs/{job_id}")

    async def create_api_key(
        self,
        label: str,
        scopes: Optional[list[str]] = None,
        expires_in_days: Optional[int] = None,
    ) -> dict[str, Any]:
        """Create a new API key for this enterprise.

        Args:
            label: Human-readable key label
            scopes: List of scopes (default: ["clusters:read", "clusters:submit_job"])
            expires_in_days: Expiration time in days (optional)

        Returns:
            New API key (only shown once) with unmasked secret.
        """
        if scopes is None:
            scopes = ["clusters:read", "clusters:submit_job"]

        return await self._http.post(
            "/v1/enterprise/api-keys",
            json={
                "label": label,
                "scopes": scopes,
                "expires_in_days": expires_in_days,
            },
        )

    async def list_api_keys(self, limit: int = 50) -> list[dict[str, Any]]:
        """List API keys for this enterprise (masked secrets).

        Args:
            limit: Max keys to return (default: 50, max: 200)

        Returns:
            List of keys with masked prefixes (last 8 chars only).
        """
        return await self._http.get("/v1/enterprise/api-keys", params={"limit": limit})

    async def revoke_api_key(self, key_id: str, reason: Optional[str] = None) -> None:
        """Revoke an API key.

        Args:
            key_id: API key ID to revoke
            reason: Optional reason for revocation (audit purposes)
        """
        params = {}
        if reason:
            params["reason"] = reason
        await self._http.post(f"/v1/enterprise/api-keys/{key_id}/revoke", json=params)

    # Synchronous variants (using asyncio.run)

    def list_clusters_sync(
        self,
        limit: int = 50,
        status: Optional[str] = None,
    ) -> list[dict[str, Any]]:
        """Synchronous version of list_clusters."""
        return asyncio.run(self.list_clusters(limit, status))

    def get_cluster_sync(self, cluster_id: str) -> dict[str, Any]:
        """Synchronous version of get_cluster."""
        return asyncio.run(self.get_cluster(cluster_id))

    def submit_job_sync(self, job_spec: dict[str, Any]) -> dict[str, Any]:
        """Synchronous version of submit_job."""
        return asyncio.run(self.submit_job(job_spec))

    def list_jobs_sync(
        self,
        limit: int = 50,
        status: Optional[str] = None,
    ) -> list[dict[str, Any]]:
        """Synchronous version of list_jobs."""
        return asyncio.run(self.list_jobs(limit, status))

    def get_job_sync(self, job_id: str) -> dict[str, Any]:
        """Synchronous version of get_job."""
        return asyncio.run(self.get_job(job_id))
