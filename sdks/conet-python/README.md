# Conet Python SDK

Simple, plug-and-play SDK for accessing Conet enterprise cluster compute.

## Installation

```bash
pip install conet
```

## Quick Start

```python
import asyncio
from conet import ConetClient

async def main():
    async with ConetClient(api_key="ent_prod_...") as client:
        # List available clusters
        clusters = await client.list_clusters(limit=10)
        for cluster in clusters:
            print(f"{cluster['handle']}: {cluster['h100_equivalent']} H100eq @ ${cluster['price_usd_per_hour']}/hr")
        
        # Get cluster details
        cluster = await client.get_cluster(clusters[0]['id'])
        print(f"Members: {cluster['member_count']}")
        
        # Submit a job
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
        print(f"Job submitted: {job['handle']}")
        
        # Check job status
        status = await client.get_job(job['id'])
        print(f"Status: {status['status']}")

asyncio.run(main())
```

## Synchronous API

For blocking code, use the `_sync` variants:

```python
from conet import ConetClient

client = ConetClient(api_key="ent_prod_...")

clusters = client.list_clusters_sync(limit=10)
job = client.submit_job_sync({...})
status = client.get_job_sync(job['id'])
```

## API Key Management

```python
async with ConetClient(api_key="ent_prod_master") as client:
    # Create a new API key with limited scopes
    new_key = await client.create_api_key(
        label="CI/CD Pipeline",
        scopes=["clusters:read", "clusters:submit_job"],
        expires_in_days=90
    )
    print(f"New key: {new_key['api_key']}")  # Only shown once!
    
    # List all keys
    keys = await client.list_api_keys()
    for key in keys:
        print(f"{key['label']}: {key['key_prefix']}")
    
    # Revoke a key
    await client.revoke_api_key(key_id="...", reason="Rotated")
```

## Error Handling

```python
from conet import (
    ConetError,
    AuthenticationError,
    NotFoundError,
    RateLimitError,
    TimeoutError,
)

async with ConetClient(api_key="ent_prod_...") as client:
    try:
        job = await client.submit_job({...})
    except AuthenticationError:
        print("Invalid API key")
    except RateLimitError:
        print("Rate limited, will retry with backoff")
    except NotFoundError:
        print("Cluster not found")
    except TimeoutError:
        print("Request timeout")
    except ConetError as e:
        print(f"Error: {e.message} (status={e.status_code})")
```

## Configuration

```python
client = ConetClient(
    api_key="ent_prod_...",
    base_url="https://api.electromesh.io",  # Default
    timeout=30.0,                            # Request timeout in seconds
    max_retries=3,                           # Retry transient failures
)
```

## Scope Reference

- `clusters:read` — List and view cluster details
- `clusters:submit_job` — Submit compute jobs
- `clusters:manage_keys` — Create/revoke API keys
- `jobs:read` — List and view job details

## Thread Safety

The client is async-first and not thread-safe. For multi-threaded usage, create separate client instances per thread or use locks.

## License

Apache 2.0
