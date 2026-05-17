from __future__ import annotations

import time
from collections.abc import Awaitable, Callable

from fastapi import Request, Response
from starlette.middleware.base import BaseHTTPMiddleware

from app.logging_setup import get_logger
from app.observability.metrics import REQUEST_COUNT, REQUEST_LATENCY


log = get_logger("http")


class RequestObservabilityMiddleware(BaseHTTPMiddleware):
    async def dispatch(
        self,
        request: Request,
        call_next: Callable[[Request], Awaitable[Response]],
    ) -> Response:
        start = time.perf_counter()
        path = _normalize_path(request.url.path)
        try:
            response = await call_next(request)
            status_code = response.status_code
            return response
        except Exception:
            status_code = 500
            raise
        finally:
            elapsed = time.perf_counter() - start
            REQUEST_COUNT.labels(
                method=request.method, path=path, status=str(status_code)
            ).inc()
            REQUEST_LATENCY.labels(method=request.method, path=path).observe(elapsed)
            log.info(
                "http.request",
                method=request.method,
                path=path,
                status=status_code,
                duration_ms=round(elapsed * 1000, 2),
            )


_TEMPLATE_PREFIXES = (
    "/v1/users/",
    "/v1/devices/",
    "/v1/clusters/",
    "/v1/jobs/",
    "/v1/payouts/",
)


def _normalize_path(path: str) -> str:
    for prefix in _TEMPLATE_PREFIXES:
        if path.startswith(prefix):
            tail = path[len(prefix):]
            if "/" in tail:
                head, rest = tail.split("/", 1)
                return f"{prefix}<id>/{rest}"
            return f"{prefix}<id>"
    return path
