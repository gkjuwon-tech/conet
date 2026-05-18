"""End-to-end test for ``compute.run`` using an httpx MockTransport.

Validates the one-liner data-plane flow:
  1. POST /v1/compute/run → returns ``{run_id, status: "queued"}``
  2. GET  /v1/compute/runs/{id} → eventually returns terminal status
  3. ``compute.run`` resolves to the final run document
"""

from __future__ import annotations

import json
from typing import Any

import httpx
import pytest

from conet import compute
from conet.compute import ClusterClient
from conet.exceptions import AuthenticationError


CLUSTER_KEY = "em_cluster_1234567890abcdef"
RUN_ID = "run_test_42"


@pytest.mark.asyncio
async def test_run_async_waits_for_terminal() -> None:
    calls: list[tuple[str, str, dict[str, Any]]] = []

    def handler(request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content) if request.content else {}
        calls.append((request.method, request.url.path, body))
        # Validate the key was sent via the data-plane header.
        assert request.headers["X-Cluster-Key"] == CLUSTER_KEY

        if request.method == "POST" and request.url.path == "/v1/compute/run":
            return httpx.Response(
                202,
                json={"run_id": RUN_ID, "status": "queued"},
            )
        if request.method == "GET" and request.url.path == f"/v1/compute/runs/{RUN_ID}":
            # Walk through states: queued → running → succeeded
            attempt = sum(1 for c in calls if c[1] == f"/v1/compute/runs/{RUN_ID}")
            statuses = ["queued", "running", "succeeded"]
            status = statuses[min(attempt - 1, len(statuses) - 1)]
            return httpx.Response(
                200,
                json={"run_id": RUN_ID, "status": status, "output": {"foo": 1} if status == "succeeded" else None},
            )
        return httpx.Response(404, json={"detail": f"unexpected {request.method} {request.url.path}"})

    transport = httpx.MockTransport(handler)
    client = ClusterClient(api_key=CLUSTER_KEY, base_url="http://test")
    # Swap in the mocked transport.
    await client._http._client.aclose()
    client._http._client = httpx.AsyncClient(
        transport=transport,
        timeout=client._http._timeout,
        headers=client._http._client.headers,
    )

    try:
        result = await client.run_and_wait(
            {"kind": "compute.shell", "compute_shell": {"command": "echo hi"}},
            timeout=10,
            poll_interval=0.0,
        )
        assert result["status"] == "succeeded"
        assert result["output"] == {"foo": 1}
        # Exactly 1 POST + N GETs
        post_calls = [c for c in calls if c[0] == "POST"]
        assert len(post_calls) == 1
        get_calls = [c for c in calls if c[0] == "GET"]
        assert len(get_calls) >= 1
    finally:
        await client.close()


@pytest.mark.asyncio
async def test_run_async_no_wait_returns_handle() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        assert request.headers["X-Cluster-Key"] == CLUSTER_KEY
        return httpx.Response(202, json={"run_id": RUN_ID, "status": "queued"})

    transport = httpx.MockTransport(handler)
    client = ClusterClient(api_key=CLUSTER_KEY, base_url="http://test")
    await client._http._client.aclose()
    client._http._client = httpx.AsyncClient(
        transport=transport,
        timeout=client._http._timeout,
        headers=client._http._client.headers,
    )

    try:
        result = await client.submit_run({"kind": "compute.shell", "compute_shell": {"command": "ls"}})
        assert result["run_id"] == RUN_ID
        assert result["status"] == "queued"
    finally:
        await client.close()


@pytest.mark.asyncio
async def test_run_async_propagates_auth_error() -> None:
    def handler(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(401, json={"detail": "invalid api key"})

    transport = httpx.MockTransport(handler)
    client = ClusterClient(api_key=CLUSTER_KEY, base_url="http://test")
    await client._http._client.aclose()
    client._http._client = httpx.AsyncClient(
        transport=transport,
        timeout=client._http._timeout,
        headers=client._http._client.headers,
    )

    try:
        with pytest.raises(AuthenticationError):
            await client.submit_run({"kind": "compute.shell"})
    finally:
        await client.close()


def test_sync_run_rejects_non_cluster_key() -> None:
    with pytest.raises(ValueError, match="em_cluster_"):
        compute.run(api_key="em_live_x", payload={"kind": "compute.shell"})
