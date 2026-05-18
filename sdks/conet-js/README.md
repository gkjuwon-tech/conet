# Conet — JavaScript / TypeScript SDK

ElectroMesh enterprise cluster compute API client.

The SDK exposes **two surfaces**, matching ElectroMesh's two key families:

| Key prefix         | Surface                       | What it does                                                       |
| ------------------ | ----------------------------- | ------------------------------------------------------------------ |
| `em_live_…`        | `ConetClient`                 | Control plane — list/buy clusters, manage API keys, read jobs.     |
| `em_cluster_…`     | `compute` / `ClusterClient`   | Data plane — submit and wait on compute runs against one cluster.  |

## Install

```bash
npm install conet
# or: pnpm add conet / yarn add conet
```

## One-liner: run compute on a purchased cluster

The whole point of the cluster key is that you can plug compute into anything
that needs it in **one import line and one call line**:

```ts
import { compute } from "conet";

const result = await compute.run({
  apiKey: "em_cluster_…",
  payload: {
    kind: "hashcrack.range",
    hashcrack_range: {
      algorithm: "sha256",
      target_hash: "9f86d081884c…",
      charset: "abcdefghijklmnopqrstuvwxyz",
      min_length: 4,
      max_length: 6,
    },
  },
});

console.log(result.status, result.output);
```

`compute.run()` blocks until the run terminates (default 1 hour) and returns
the final run document. Pass `wait: false` to get only the queued handle.

For long-running orchestrators, use the class directly:

```ts
import { ClusterClient } from "conet";

const c = new ClusterClient({ apiKey: "em_cluster_…" });
const { run_id } = await c.submitRun({ kind: "ml.embed.public", ml_embed_public: {...} });

while (true) {
  const run = await c.getRun(run_id);
  if (["succeeded","failed","cancelled","timed_out","rejected"].includes(run.status)) {
    console.log(run);
    break;
  }
  await new Promise(r => setTimeout(r, 2_000));
}
```

## Control plane (access key)

```ts
import { ConetClient, compute } from "conet";

const c = new ConetClient("em_live_…");

// 1. browse clusters
const clusters = await c.listClusters({ limit: 10 });
for (const cl of clusters) {
  console.log(cl.handle, cl.h100_equivalent, "@", cl.price_usd_per_hour, "USD/hr");
}

// 2. purchase one — mints an em_cluster_… key bound to that cluster
const issued = await c.purchaseCluster(clusters[0].id, {
  label: "prod-train",
  budget_cents: 50_000,        // $500 cap
  expires_in_days: 30,
});
const clusterKey = issued.api_key;  // only shown ONCE — store immediately

// 3. hand the cluster key to whatever needs compute
const run = await compute.run({ apiKey: clusterKey, payload: {...} });
console.log(run.status);
```

### Other control-plane operations

```ts
// access keys (control plane)
await c.listApiKeys();                    // both kinds
await c.listApiKeys({ kind: "access" });  // only em_live_…
await c.listApiKeys({ kind: "cluster" }); // only em_cluster_…
await c.listClusterKeys();                // convenience

// mint a new access key
const k = await c.createApiKey({
  label: "ci-pipeline",
  scopes: ["clusters:read", "clusters:purchase"],
  expires_in_days: 90,
});

// revoke
await c.revokeApiKey(k.id);
await c.revokeClusterKey(someClusterKeyId);

// jobs (legacy job kind, runs through /v1/jobs)
const jobs = await c.listJobs({ limit: 20 });
const job = await c.submitJob({ kind: "hashcrack.range", ...});
```

## Auth headers (what the SDK actually sends)

You almost never need to think about this, but for the curious:

| Your key starts with… | The SDK sets…                                              |
| --------------------- | ---------------------------------------------------------- |
| `em_cluster_`         | `X-Cluster-Key: <key>` (also `X-API-Key` for older brokers)|
| `em_live_`            | `X-API-Key: <key>`                                         |
| anything else         | `X-API-Key` **and** `Authorization: Bearer`                |

`ConetClient` refuses `em_cluster_…` keys at construction time, and
`ClusterClient` refuses anything that isn't `em_cluster_…` — so you can't
accidentally cross the wires.

## Error handling

```ts
import {
  ConetError,
  AuthenticationError,
  NotFoundError,
  RateLimitError,
  TimeoutError,
  ValidationError,
} from "conet";

try {
  const run = await compute.run({ apiKey, payload });
} catch (err) {
  if (err instanceof AuthenticationError) {
    console.error("key is bad / revoked / wrong kind");
  } else if (err instanceof RateLimitError) {
    console.error("rate limited; SDK already retried with backoff");
  } else if (err instanceof TimeoutError) {
    console.error("run did not finish before timeout");
  } else if (err instanceof ConetError) {
    console.error("API error:", err.status, err.message);
  } else {
    throw err;
  }
}
```

## Scopes (access keys)

| Scope                    | Lets the key…                                                  |
| ------------------------ | -------------------------------------------------------------- |
| `clusters:read`          | List clusters + read anonymized composition / pricing.         |
| `clusters:purchase`      | Call `purchaseCluster()` and mint cluster keys.                |
| `clusters:manage_keys`   | Create + revoke other API keys (both kinds).                   |
| `jobs:read`              | Read previously-submitted jobs.                                |
| `clusters:submit_job`    | Submit jobs via the legacy `/v1/jobs` surface.                 |

Cluster keys carry the fixed scope `compute:run` and are confined to the
cluster they were purchased for.

## Configuration

```ts
new ConetClient("em_live_…", {
  baseUrl: "https://api.electromesh.io",
  timeout: 30_000,
  maxRetries: 3,
});

new ClusterClient({
  apiKey: "em_cluster_…",
  baseUrl: "http://localhost:8080",
  timeout: 30_000,
});
```

## Browser support

The SDK ships as ESM + CJS and is browser-compatible, but most production
deployments call this from a Node service (CI runner, queue worker, edge
function) — that way the cluster key never leaves your trust boundary.

## License

Apache 2.0
