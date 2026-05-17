"""HTTP client with retry logic and exponential backoff."""

from __future__ import annotations

import asyncio
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


class HttpClient:
    """HTTP client with retry logic for Conet API."""

    def __init__(
        self,
        base_url: str,
        api_key: str,
        timeout: float = 30.0,
        max_retries: int = 3,
    ):
        self.base_url = base_url.rstrip("/")
        self.api_key = api_key
        self.timeout = timeout
        self.max_retries = max_retries
        self._client: httpx.AsyncClient | None = None

    async def _get_client(self) -> httpx.AsyncClient:
        """Get or create async HTTP client."""
        if self._client is None:
            self._client = httpx.AsyncClient(timeout=self.timeout)
        return self._client

    async def close(self) -> None:
        """Close HTTP client."""
        if self._client:
            await self._client.aclose()
            self._client = None

    async def __aenter__(self) -> HttpClient:
        return self

    async def __aexit__(self, *args: Any) -> None:
        await self.close()

    async def _make_request(
        self,
        method: str,
        path: str,
        **kwargs: Any,
    ) -> dict[str, Any]:
        """Make HTTP request with retry logic."""
        url = f"{self.base_url}{path}"
        headers = kwargs.pop("headers", {})
        headers["Authorization"] = f"Bearer {self.api_key}"
        headers["User-Agent"] = "conet-python/0.1.0"

        for attempt in range(self.max_retries + 1):
            try:
                client = await self._get_client()
                response = await client.request(
                    method,
                    url,
                    headers=headers,
                    **kwargs,
                )

                if response.status_code < 400:
                    return response.json() if response.content else {}

                if response.status_code == 401:
                    raise AuthenticationError(
                        "Invalid API key",
                        status_code=response.status_code,
                    )

                if response.status_code == 404:
                    raise NotFoundError(
                        "Resource not found",
                        status_code=response.status_code,
                    )

                if response.status_code == 429:
                    if attempt < self.max_retries:
                        wait_time = (2 ** attempt) * 0.1
                        await asyncio.sleep(min(wait_time, 10.0))
                        continue
                    raise RateLimitError(
                        "Rate limit exceeded",
                        status_code=response.status_code,
                    )

                if response.status_code >= 500:
                    if attempt < self.max_retries:
                        wait_time = (2 ** attempt) * 0.1
                        await asyncio.sleep(min(wait_time, 10.0))
                        continue
                    raise ServerError(
                        f"Server error: {response.status_code}",
                        status_code=response.status_code,
                    )

                if response.status_code >= 400:
                    detail = "Unknown error"
                    try:
                        data = response.json()
                        detail = data.get("detail", detail)
                    except Exception:
                        pass

                    raise ValidationError(
                        detail,
                        status_code=response.status_code,
                    )

                return response.json() if response.content else {}

            except (httpx.TimeoutException, asyncio.TimeoutError):
                if attempt < self.max_retries:
                    wait_time = (2 ** attempt) * 0.1
                    await asyncio.sleep(min(wait_time, 10.0))
                    continue
                raise TimeoutError(f"Request timed out after {self.timeout}s")
            except (AuthenticationError, NotFoundError, ConetError):
                raise
            except Exception as e:
                raise ConetError(f"Request failed: {e}") from e

    async def get(self, path: str, params: dict[str, Any] | None = None) -> Any:
        """GET request."""
        return await self._make_request("GET", path, params=params)

    async def post(self, path: str, json: dict[str, Any] | None = None) -> Any:
        """POST request."""
        return await self._make_request("POST", path, json=json)

    async def post_form(self, path: str, data: dict[str, Any]) -> Any:
        """POST form-encoded request."""
        return await self._make_request("POST", path, data=data)
