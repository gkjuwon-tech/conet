// Pinned tests for the SDK's outgoing header decision. The backend
// resolver lives in backend/app/auth/dependencies.py and accepts three
// header families — make sure we pick the right one for each key prefix.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  ClusterClient,
  ConetClient,
  compute,
} from "../dist/index.js";

const realFetch = globalThis.fetch;

function mockFetch(handler) {
  globalThis.fetch = async (url, init) => {
    return handler(url, init);
  };
  return () => {
    globalThis.fetch = realFetch;
  };
}

test("cluster key sends X-Cluster-Key", async () => {
  let seen = null;
  const restore = mockFetch(async (url, init) => {
    seen = { url: String(url), headers: init.headers };
    return new Response(JSON.stringify({ run_id: "r1", status: "queued" }), {
      status: 202,
      headers: { "content-type": "application/json" },
    });
  });
  try {
    const client = new ClusterClient("em_cluster_abc", { baseUrl: "http://t" });
    await client.submitRun({ kind: "compute.shell" });
    assert.equal(seen.headers["X-Cluster-Key"], "em_cluster_abc");
    assert.equal(seen.headers["X-API-Key"], "em_cluster_abc");
    assert.equal(seen.headers["Authorization"], undefined);
  } finally {
    restore();
  }
});

test("access key sends X-API-Key only", async () => {
  let seen = null;
  const restore = mockFetch(async (url, init) => {
    seen = { url: String(url), headers: init.headers };
    return new Response(JSON.stringify([]), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  });
  try {
    const client = new ConetClient("em_live_abc", { baseUrl: "http://t" });
    await client.listClusters();
    assert.equal(seen.headers["X-API-Key"], "em_live_abc");
    assert.equal(seen.headers["X-Cluster-Key"], undefined);
    assert.equal(seen.headers["Authorization"], undefined);
  } finally {
    restore();
  }
});

test("ClusterClient refuses non-cluster keys", () => {
  assert.throws(() => new ClusterClient("em_live_x"), /em_cluster_/);
  assert.throws(() => new ClusterClient(""), /required/);
});

test("ConetClient refuses cluster keys", () => {
  assert.throws(() => new ConetClient("em_cluster_x"), /em_live_/);
  assert.throws(() => new ConetClient(""), /required/);
});

test("compute.run waits for terminal state", async () => {
  let polls = 0;
  const restore = mockFetch(async (url) => {
    const u = String(url);
    if (u.endsWith("/v1/compute/run")) {
      return new Response(
        JSON.stringify({ run_id: "r1", status: "queued" }),
        { status: 202, headers: { "content-type": "application/json" } }
      );
    }
    if (u.endsWith("/v1/compute/runs/r1")) {
      polls++;
      const status = polls >= 2 ? "succeeded" : "running";
      return new Response(
        JSON.stringify({ run_id: "r1", status, output: status === "succeeded" ? { ok: true } : null }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    }
    return new Response("nope", { status: 404 });
  });
  try {
    const result = await compute.run({
      apiKey: "em_cluster_xyz",
      payload: { kind: "compute.shell" },
      baseUrl: "http://t",
      pollIntervalMs: 0,
      timeoutMs: 5_000,
    });
    assert.equal(result.status, "succeeded");
    assert.deepEqual(result.output, { ok: true });
    assert.ok(polls >= 1);
  } finally {
    restore();
  }
});
