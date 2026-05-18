/**
 * Conet — ElectroMesh enterprise compute API client.
 *
 * Two ways to use this package:
 *
 * 1. **Control plane (access key)** — list/buy clusters, manage API keys.
 *    ```ts
 *    import { ConetClient } from "conet";
 *    const c = new ConetClient("em_live_…");
 *    const clusters = await c.listClusters();
 *    const purchase = await c.purchaseCluster(clusters[0].id, {
 *      label: "prod", budget_cents: 50_000,
 *    });
 *    ```
 *
 * 2. **Data plane (cluster key)** — actually run compute, in one line.
 *    ```ts
 *    import { compute } from "conet";
 *    const result = await compute.run({
 *      apiKey: "em_cluster_…",
 *      payload: { ... },
 *    });
 *    ```
 */

export { ConetClient, type ConetClientOptions } from './client.js';
export {
  ClusterClient,
  compute,
  run,
  type ClusterClientOptions,
  type RunOptions,
} from './compute.js';
export * from './types.js';
export * from './errors.js';
