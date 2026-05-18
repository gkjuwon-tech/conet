"""``conet.compute`` — one-liner compute submission for SDK consumers.

The whole point of this module is::

    from conet import compute

    result = compute.run(
        api_key="em_cluster_…",
        payload={
            "kind": "hashcrack.range",
            "hashcrack_range": {
                "algorithm": "sha256",
                "target_hash": "9f86d…",
                "charset": "abcdefghijklmnopqrstuvwxyz",
                "min_length": 4,
                "max_length": 6,
            },
        },
    )
    print(result["status"], result.get("output"))

That's it. No client to construct, no async dance, no manual polling — by
default :func:`run` blocks until the run terminates (or until ``timeout``
elapses) and returns the final state.

If you want streaming or cancellation, instantiate :class:`ClusterClient`
yourself and call ``submit_run`` / ``get_run`` / ``cancel_run`` directly.
"""

from __future__ import annotations

import asyncio
import time
from typing import Any

from conet._http import HttpClient
from conet.exceptions import TimeoutError as ConetTimeoutError

DEFAULT_BASE_URL = "https://api.electromesh.io"
DEFAULT_POLL_INTERVAL = 2.0
DEFAULT_RUN_TIMEOUT = 3600.0  # 1 hour

_TERMINAL_STATUSES = frozenset(
    {"succeeded", "failed", "cancelled", "timed_out", "rejected"}
)


class ClusterClient:
    """Async client authenticated with an ``em_cluster_…`` key."""

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
        if not api_key.startswith("em_cluster_"):
            raise ValueError(
                "ClusterClient requires an em_cluster_ key — purchase one via "
                "ConetClient.purchase_cluster(cluster_id, ...)"
            )
        self.api_key = api_key
        self.base_url = base_url
        self._http = HttpClient(base_url, api_key, timeout=timeout, max_retries=max_retries)

    async def __aenter__(self) -> "ClusterClient":
        return self

    async def __aexit__(self, *_exc: Any) -> None:
        await self.close()

    async def close(self) -> None:
        await self._http.close()

    async def submit_run(self, payload: dict[str, Any]) -> dict[str, Any]:
        """Submit a workload. Returns the queued run handle immediately."""
        return await self._http.post("/v1/compute/run", json=payload)

    async def get_run(self, run_id: str) -> dict[str, Any]:
        """Look up a run by ``run_id`` (the job handle)."""
        return await self._http.get(f"/v1/compute/runs/{run_id}")

    async def cancel_run(self, run_id: str, *, reason: str | None = None) -> dict[str, Any]:
        return await self._http.post(
            f"/v1/compute/runs/{run_id}/cancel",
            json={"reason": reason} if reason else {},
        )

    async def run_and_wait(
        self,
        payload: dict[str, Any],
        *,
        timeout: float = DEFAULT_RUN_TIMEOUT,
        poll_interval: float = DEFAULT_POLL_INTERVAL,
    ) -> dict[str, Any]:
        """Submit and block until the run reaches a terminal state."""
        created = await self.submit_run(payload)
        run_id = created["run_id"]
        deadline = time.monotonic() + timeout

        while True:
            run = await self.get_run(run_id)
            if run["status"] in _TERMINAL_STATUSES:
                return run
            if time.monotonic() >= deadline:
                raise ConetTimeoutError(
                    f"run {run_id} did not finish within {timeout:.0f}s",
                )
            await asyncio.sleep(poll_interval)


def run(
    *,
    api_key: str,
    payload: dict[str, Any],
    base_url: str = DEFAULT_BASE_URL,
    timeout: float = DEFAULT_RUN_TIMEOUT,
    poll_interval: float = DEFAULT_POLL_INTERVAL,
    wait: bool = True,
) -> dict[str, Any]:
    """Synchronous one-liner that submits a workload and waits for the result.

    ``api_key`` must be a cluster key (``em_cluster_…``). When ``wait`` is
    ``False``, only the queued handle is returned and the caller is
    responsible for polling. This function spins up its own event loop and
    is **not safe** to call from inside an existing one — use
    :func:`run_async` instead in that case.
    """
    return asyncio.run(
        run_async(
            api_key=api_key,
            payload=payload,
            base_url=base_url,
            timeout=timeout,
            poll_interval=poll_interval,
            wait=wait,
        )
    )


async def run_async(
    *,
    api_key: str,
    payload: dict[str, Any],
    base_url: str = DEFAULT_BASE_URL,
    timeout: float = DEFAULT_RUN_TIMEOUT,
    poll_interval: float = DEFAULT_POLL_INTERVAL,
    wait: bool = True,
) -> dict[str, Any]:
    """Async variant of :func:`run` — safe to call inside an event loop."""
    async with ClusterClient(api_key, base_url=base_url) as client:
        if not wait:
            return await client.submit_run(payload)
        return await client.run_and_wait(
            payload, timeout=timeout, poll_interval=poll_interval
        )


__all__ = ["ClusterClient", "run", "run_async"]
