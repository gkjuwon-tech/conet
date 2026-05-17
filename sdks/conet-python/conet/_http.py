"""HTTP transport with exponential-backoff retries on 429/5xx."""

from __future__ import annotations

import asyncio
import random
from typing import Any

import httpx

from conet.exceptions import (
    AuthenticationError,
    ConetError,
    NotFoundError,
    RateLimitError,
    ServerError,
    TimeoutError,
    ValidationError,
)

_USER_AGENT = "conet-python/0.1.0"


class HttpClient:
    """Thin async wrapper around httpx with our retry policy."""

    def __init__(
        self,
        base_url: str,
        api_key: str,
        *,
        timeout: float = 30.0,
        max_retries: int = 3,
    ) -> None:
        self._base_url = base_url.rstrip("/")
        self._api_key = api_key
        self._timeout = timeout
        self._max_retries = max_retries
        self._client = httpx.AsyncClient(
            timeout=timeout,
            headers={
                "User-Agent": _USER_AGENT,
                "Authorization": f"Bearer {api_key}",
            },
        )

    async def close(self) -> None:
        await self._client.aclose()

    async def get(self, path: str, *, params: dict[str, Any] | None = None) -> Any:
        return await self._request("GET", path, params=params)

    async def post(self, path: str, *, json: dict[str, Any] | None = None) -> Any:
        return await self._request("POST", path, json=json)

    async def delete(self, path: str, *, json: dict[str, Any] | None = None) -> Any:
        return await self._request("DELETE", path, json=json)

    async def _request(
        self,
        method: str,
        path: str,
        *,
        params: dict[str, Any] | None = None,
        json: dict[str, Any] | None = None,
    ) -> Any:
        url = self._base_url + path
        last_exc: Exception | None = None

        for attempt in range(self._max_retries + 1):
            try:
                response = await self._client.request(method, url, params=params, json=json)
            except httpx.TimeoutException as exc:
                last_exc = TimeoutError(f"timed out after {self._timeout:.1f}s") from exc
                await self._maybe_sleep(attempt)
                continue
            except httpx.HTTPError as exc:
                last_exc = ConetError(f"transport error: {exc}") from exc
                await self._maybe_sleep(attempt)
                continue

            if response.status_code < 400:
                return _parse_body(response)

            err = _build_error(response)
            # retry transient errors (429, 5xx); fail fast on 4xx
            if isinstance(err, (RateLimitError, ServerError)) and attempt < self._max_retries:
                last_exc = err
                await self._maybe_sleep(attempt, hint_retry_after=response.headers.get("Retry-After"))
                continue
            raise err

        assert last_exc is not None
        raise last_exc

    async def _maybe_sleep(self, attempt: int, *, hint_retry_after: str | None = None) -> None:
        if hint_retry_after:
            try:
                await asyncio.sleep(max(0.0, float(hint_retry_after)))
                return
            except ValueError:
                pass
        # exponential backoff with jitter: 0.2, 0.4, 0.8, ... capped at 8s
        wait = min(8.0, 0.2 * (2 ** attempt)) + random.uniform(0, 0.1)
        await asyncio.sleep(wait)


def _parse_body(response: httpx.Response) -> Any:
    if not response.content:
        return None
    try:
        return response.json()
    except ValueError:
        return response.text


def _build_error(response: httpx.Response) -> ConetError:
    detail = "unknown error"
    try:
        body = response.json()
        if isinstance(body, dict):
            detail = body.get("detail") or body.get("message") or detail
            if isinstance(detail, list):  # FastAPI validation
                detail = "; ".join(
                    f"{'.'.join(str(p) for p in d.get('loc', []))}: {d.get('msg', '')}"
                    for d in detail if isinstance(d, dict)
                ) or "validation failed"
    except ValueError:
        if response.text:
            detail = response.text[:200]

    status = response.status_code
    if status == 401 or status == 403:
        return AuthenticationError(str(detail), status_code=status)
    if status == 404:
        return NotFoundError(str(detail), status_code=status)
    if status == 429:
        return RateLimitError(str(detail), status_code=status)
    if status >= 500:
        return ServerError(str(detail), status_code=status)
    return ValidationError(str(detail), status_code=status)
