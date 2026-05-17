# Conet JavaScript SDK

Simple, plug-and-play SDK for accessing Conet enterprise cluster compute from Node.js and the browser.

## Installation

```bash
npm install conet
# or
yarn add conet
# or
pnpm add conet
```

## Quick Start

```typescript
import { ConetClient } from 'conet';

const client = new ConetClient('ent_prod_...');

// List available clusters
const clusters = await client.listClusters({ limit: 10 });
clusters.forEach(cluster => {
  console.log(`${cluster.handle}: ${cluster.h100_equivalent} H100eq @ $${cluster.price_usd_per_hour}/hr`);
});

// Get cluster details
const cluster = await client.getCluster(clusters[0].id);
console.log(`Members: ${cluster.member_count}`);

// Submit a job
const job = await client.submitJob({
  kind: 'hashcrack.range',
  max_budget_cents: 10000,
  hashcrack_range: {
    algorithm: 'sha256',
    target_hash: 'abc123...',
    charset: '0123456789abcdef',
    min_length: 6,
    max_length: 8,
  }
});
console.log(`Job submitted: ${job.handle}`);

// Check job status
const status = await client.getJob(job.id);
console.log(`Status: ${status.status}`);
```

## API Key Management

```typescript
// Create a new API key with limited scopes
const newKey = await client.createApiKey({
  label: 'CI/CD Pipeline',
  scopes: ['clusters:read', 'clusters:submit_job'],
  expires_in_days: 90
});
console.log(`New key: ${newKey.api_key}`); // Only shown once!

// List all keys
const keys = await client.listApiKeys();
keys.forEach(key => {
  console.log(`${key.label}: ${key.key_prefix}`);
});

// Revoke a key
await client.revokeApiKey(keyId, 'Rotated');
```

## Error Handling

```typescript
import {
  ConetClient,
  AuthenticationError,
  NotFoundError,
  RateLimitError,
  TimeoutError,
} from 'conet';

const client = new ConetClient('ent_prod_...');

try {
  const job = await client.submitJob({...});
} catch (error) {
  if (error instanceof AuthenticationError) {
    console.error('Invalid API key');
  } else if (error instanceof RateLimitError) {
    console.error('Rate limited, will retry with backoff');
  } else if (error instanceof NotFoundError) {
    console.error('Cluster not found');
  } else if (error instanceof TimeoutError) {
    console.error('Request timeout');
  } else {
    console.error(`Error: ${error.message}`);
  }
}
```

## Configuration

```typescript
const client = new ConetClient(
  'ent_prod_...',
  {
    baseUrl: 'https://api.electromesh.io', // Default
    timeout: 30_000,                        // Request timeout in ms
    maxRetries: 3,                          // Retry transient failures
  }
);
```

## Scope Reference

- `clusters:read` — List and view cluster details
- `clusters:submit_job` — Submit compute jobs
- `clusters:manage_keys` — Create/revoke API keys
- `jobs:read` — List and view job details

## Examples

### Real-world workflow: Hash cracking

```typescript
const client = new ConetClient(process.env.CONET_API_KEY!);

// Find the cheapest cluster
const clusters = await client.listClusters({ limit: 100 });
clusters.sort((a, b) => a.price_usd_per_hour - b.price_usd_per_hour);

// Submit job to crack SHA256
const job = await client.submitJob({
  kind: 'hashcrack.range',
  title: 'Crack victim password',
  max_budget_cents: 5000,  // $50 max
  max_runtime_seconds: 3600,
  hashcrack_range: {
    algorithm: 'sha256',
    target_hash: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    charset: 'abcdefghijklmnopqrstuvwxyz0123456789',
    min_length: 4,
    max_length: 8,
  }
});

console.log(`Job ${job.handle} submitted`);

// Poll for completion
let complete = false;
while (!complete) {
  await new Promise(resolve => setTimeout(resolve, 5000)); // 5s poll interval
  const status = await client.getJob(job.id);
  console.log(`Status: ${status.status}, spent: $${(status.spent_cents / 100).toFixed(2)}`);
  
  if (status.status === 'completed' || status.status === 'failed') {
    complete = true;
  }
}
```

### Webhook integration

```typescript
// Accept job results via webhook
import express from 'express';

const app = express();
app.post('/webhook/conet', express.json(), (req, res) => {
  const { job_id, status, output_manifest } = req.body;
  
  if (status === 'completed') {
    console.log('Job complete:', output_manifest);
  }
  
  res.json({ ok: true });
});
```

## Browser Support

The SDK is browser-compatible but requires a CORS proxy or backend relay for API calls (browsers can't make cross-origin requests with custom Authorization headers). For browser usage, create a backend API endpoint that uses this SDK.

```typescript
// Example: Next.js API route
import { ConetClient } from 'conet';

export default async function handler(req, res) {
  const client = new ConetClient(process.env.CONET_API_KEY!);
  const clusters = await client.listClusters();
  res.json(clusters);
}
```

## License

Apache 2.0
