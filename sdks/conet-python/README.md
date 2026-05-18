# Conet — Python SDK

ElectroMesh enterprise cluster compute API client.

The SDK exposes **two surfaces**, matching ElectroMesh's two key families:

| Key prefix         | Surface             | What it does                                                         |
| ------------------ | ------------------- | -------------------------------------------------------------------- |
| `em_live_…`        | `ConetClient`       | Control plane — list/buy clusters, manage API keys, read jobs.       |
| `em_cluster_…`     | `conet.compute`     | Data plane — submit and wait on compute runs against one cluster.    |

## Install

```bash
pip install conet
```

## One-liner: run compute on a purchased cluster

The whole point of the cluster key is that you can plug compute into anything
that needs it in **one import line and one call line**:

```python
from conet import compute

result = compute.run(
    api_key="em_cluster_…",
    payload={
        "kind": "hashcrack.range",
        "hashcrack_range": {
            "algorithm": "sha256",
            "target_hash": "9f86d081884c…",
            "charset": "abcdefghijklmnopqrstuvwxyz",
            "min_length": 4,
            "max_length": 6,
        },
    },
)

print(result["status"], result.get("output"))
```

`compute.run()` blocks until the run terminates (default 1 hour) and returns
the final run document. Pass `wait=False` to get only the queued handle.

For long-running orchestrators, use the async variant:

```python
import asyncio
from conet import compute, ClusterClient

async def main():
    async with ClusterClient(api_key="em_cluster_…") as c:
        created = await c.submit_run({"kind": "ml.embed.public", "ml_embed_public": {...}})
        while True:
            run = await c.get_run(created["run_id"])
            if run["status"] in {"succeeded", "failed", "cancelled", "timed_out", "rejected"}:
                return run
            await asyncio.sleep(2)

asyncio.run(main())
```

## Control plane (access key)

```python
import asyncio
from conet import ConetClient

async def main():
    async with ConetClient(api_key="em_live_…") as c:
        # 1. browse clusters
        clusters = await c.list_clusters(limit=10)
        for c_ in clusters:
            print(c_["handle"], c_["h100_equivalent"], "@", c_["price_usd_per_hour"], "USD/hr")

        # 2. purchase one — mints an em_cluster_… key bound to that cluster
        issued = await c.purchase_cluster(
            clusters[0]["id"],
            label="prod-train",
            budget_cents=50_000,           # $500 cap
            expires_in_days=30,
        )
        cluster_key = issued["api_key"]    # only shown ONCE — store immediately

        # 3. hand the cluster key to whatever needs compute
        from conet import compute
        run = compute.run(api_key=cluster_key, payload={...})
        print(run["status"])

asyncio.run(main())
```

### Other control-plane operations

```python
async with ConetClient(api_key="em_live_…") as c:
    # access keys (control plane)
    await c.list_api_keys()                    # both kinds
    await c.list_api_keys(kind="access")       # only em_live_…
    await c.list_api_keys(kind="cluster")      # only em_cluster_…
    await c.list_cluster_keys()                # convenience for kind="cluster"

    # mint a new access key (e.g. for CI)
    issued = await c.create_api_key(
        label="ci-pipeline",
        scopes=["clusters:read", "clusters:purchase"],
        expires_in_days=90,
    )

    # revoke
    await c.revoke_api_key(issued["id"])

    # jobs (legacy job kind, runs through /v1/jobs)
    jobs = await c.list_jobs(limit=20)
    job = await c.submit_job({"kind": "hashcrack.range", ...})
    detail = await c.get_job(job["id"])
```

## Auth headers (what the SDK actually sends)

You almost never need to think about this, but for the curious:

| Your key starts with… | The SDK sets…                                |
| --------------------- | -------------------------------------------- |
| `em_cluster_`         | `X-Cluster-Key: <key>` (also `X-API-Key` for older brokers) |
| `em_live_`            | `X-API-Key: <key>`                           |
| anything else         | `X-API-Key` **and** `Authorization: Bearer`  |

So you can paste any key into either `ConetClient(api_key=…)` (control plane) or
`compute.run(api_key=…)` (data plane) and the SDK will refuse the mismatched
ones with a clear error before it ever hits the wire.

## Error handling

```python
from conet import (
    ConetError,
    AuthenticationError,
    NotFoundError,
    RateLimitError,
    TimeoutError,
    ValidationError,
    ServerError,
)

try:
    result = compute.run(api_key=key, payload=payload)
except AuthenticationError:
    print("key is bad / revoked / wrong kind")
except RateLimitError:
    print("backend asked us to slow down; SDK already retried with backoff")
except TimeoutError:
    print("run did not finish before the timeout we passed")
except ConetError as err:
    print("API error:", err.status_code, err.message)
```

## Scopes (access keys)

| Scope                    | Lets the key…                                                  |
| ------------------------ | -------------------------------------------------------------- |
| `clusters:read`          | List clusters + read anonymized composition / pricing.         |
| `clusters:purchase`      | Call `purchase_cluster()` and mint cluster keys.               |
| `clusters:manage_keys`   | Create + revoke other API keys (both kinds).                   |
| `jobs:read`              | Read previously-submitted jobs.                                |
| `clusters:submit_job`    | Submit jobs via the legacy `/v1/jobs` surface.                 |

Cluster keys carry the fixed scope `compute:run` and are confined to the
cluster they were purchased for.

## Configuration

```python
from conet import ConetClient, ClusterClient

c = ConetClient(
    api_key="em_live_…",
    base_url="https://api.electromesh.io",
    timeout=30.0,
    max_retries=3,
)

cc = ClusterClient(api_key="em_cluster_…", base_url="http://localhost:8080")
```

## License

Apache 2.0
