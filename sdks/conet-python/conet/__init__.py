"""Conet — ElectroMesh enterprise compute API client.

Two ways to use this package:

1. **Control plane (access key)** — list/buy clusters, manage API keys::

       from conet import ConetClient

       async with ConetClient(api_key="em_live_…") as c:
           clusters = await c.list_clusters()
           result = await c.purchase_cluster(
               clusters[0]["id"], label="prod", budget_cents=50_000
           )

2. **Data plane (cluster key)** — actually run work, in one line::

       from conet import compute

       result = compute.run(api_key="em_cluster_…", payload={...})
"""

from __future__ import annotations

__version__ = "0.2.0"

from conet import compute
from conet.client import ConetClient
from conet.compute import ClusterClient
from conet.exceptions import (
    AuthenticationError,
    ConetError,
    NotFoundError,
    RateLimitError,
    ServerError,
    TimeoutError,
    ValidationError,
)

__all__ = [
    "ConetClient",
    "ClusterClient",
    "compute",
    "ConetError",
    "AuthenticationError",
    "NotFoundError",
    "RateLimitError",
    "ServerError",
    "TimeoutError",
    "ValidationError",
]
