# Fly.io Deployment — ElectroMesh Backend

This runbook covers everything from a fresh Fly account to a running
`https://electromesh-api.fly.dev` plus a Celery worker app, Postgres,
and Redis. Copy-paste friendly.

> All commands are run from this directory: `backend/`.

---

## 0. Prereqs

```bash
# Install flyctl (macOS / Linux)
curl -L https://fly.io/install.sh | sh

# Or macOS Homebrew:
brew install flyctl

# Sign in (opens browser)
fly auth login
```

---

## 1. Create the apps (one-time)

You'll end up with **three** Fly apps:

| App                       | Purpose                              |
| ------------------------- | ------------------------------------ |
| `electromesh-api`         | FastAPI web service (this fly.toml)  |
| `electromesh-worker`      | Celery worker pool                   |
| `electromesh-db` *(opt.)* | Managed Postgres (use Fly Postgres)  |

```bash
# Web app — uses this directory's fly.toml.
fly apps create electromesh-api

# Worker app — same Docker image, different process group.
fly apps create electromesh-worker
```

### Postgres

You can either:

**(a) Use Fly Postgres (easiest):**

```bash
fly postgres create \
  --name electromesh-db \
  --region nrt \
  --vm-size shared-cpu-1x \
  --volume-size 10 \
  --initial-cluster-size 1

# Attach to the API app — this auto-sets DATABASE_URL.
fly postgres attach electromesh-db --app electromesh-api
fly postgres attach electromesh-db --app electromesh-worker

# Fly attaches as DATABASE_URL — alias it to EM_DATABASE_URL.
fly secrets set --app electromesh-api \
  EM_DATABASE_URL="$(fly ssh console --app electromesh-api -C 'printenv DATABASE_URL' | tr -d '\r')"
```

**(b) Bring your own Postgres** (Supabase, Neon, RDS, etc.) — set the
URL directly:

```bash
fly secrets set --app electromesh-api \
  EM_DATABASE_URL="postgresql+psycopg://USER:PASS@HOST:5432/DB?sslmode=require"
```

> The app driver is `psycopg` (v3, async-capable). Don't switch to
> `postgresql+asyncpg://` unless you also update SQLAlchemy's engine.

### Redis

```bash
# Easiest: use Upstash via Fly's marketplace.
fly redis create   # follow the prompts, pick `nrt`
fly redis status   # copy the connection URL
fly secrets set --app electromesh-api \
  EM_REDIS_URL="redis://default:PASSWORD@HOST:PORT/0"
fly secrets set --app electromesh-worker \
  EM_REDIS_URL="redis://default:PASSWORD@HOST:PORT/0"
```

---

## 2. Secrets

Set everything that isn't already in `fly.toml`'s `[env]` block:

```bash
fly secrets set --app electromesh-api \
  EM_JWT_SECRET="$(openssl rand -hex 32)" \
  EM_STRIPE_SECRET_KEY="sk_live_..." \
  EM_STRIPE_WEBHOOK_SECRET="whsec_..." \
  EM_STRIPE_PUBLISHABLE_KEY="pk_live_..." \
  EM_SENTRY_DSN="https://...@sentry.io/..." \
  EM_CORS_ORIGINS="https://app.electromesh.dev,https://dashboard.electromesh.dev"
```

> Mirror the same secrets to `electromesh-worker` so background jobs can
> connect to Stripe / DB / Redis identically.

---

## 3. First deploy

```bash
# From backend/  ── fly.toml is here.
fly deploy --remote-only
```

What happens:

1. Fly's builder builds the multi-stage Dockerfile.
2. `[deploy].release_command = "alembic upgrade head"` runs on a release
   machine. If migrations fail, the deploy aborts — no traffic flips.
3. The new image gets rolled out (rolling strategy).
4. Liveness / readiness probes go green; old machines are reaped.

Tail the logs:

```bash
fly logs --app electromesh-api
```

Hit the URL:

```bash
curl https://electromesh-api.fly.dev/healthz
curl https://electromesh-api.fly.dev/readyz
```

---

## 4. Worker deploy

The Celery worker uses the **same image** but a different command. Drop
a sibling `fly.worker.toml` next to this file (or override on the CLI):

```bash
fly deploy \
  --app electromesh-worker \
  --config fly.toml \
  --remote-only \
  --image registry.fly.io/electromesh-api:deployment-LATEST \
  --no-public-ips \
  --process-group worker
```

Or — simpler — write a `fly.worker.toml`:

```toml
app = "electromesh-worker"
primary_region = "nrt"

[build]
  dockerfile = "Dockerfile"

[env]
  EM_ENV = "prod"
  EM_METRICS_ENABLED = "false"

[processes]
  worker = "celery -A app.tasks worker --loglevel=INFO --concurrency=4"

[[vm]]
  size = "shared-cpu-1x"
  memory = "512mb"
```

Then:

```bash
fly deploy --config fly.worker.toml --remote-only
```

---

## 5. Scaling

```bash
# Scale horizontally
fly scale count 2 --app electromesh-api

# Bigger machines for the worker
fly scale vm shared-cpu-2x --memory 1024 --app electromesh-worker

# Add a second region
fly regions add iad --app electromesh-api
```

---

## 6. Migrations after the first deploy

You don't have to do anything special — `[deploy].release_command`
re-runs `alembic upgrade head` on every deploy. If you need to roll
back:

```bash
# Run a one-off command on a release machine.
fly ssh console --app electromesh-api -C "alembic downgrade -1"
```

---

## 7. Smoke checks

```bash
# Spawn a one-off shell
fly ssh console --app electromesh-api

# From the shell:
alembic current
python -c "from app.config import get_settings; s = get_settings(); print(s.env, s.api_port)"
curl -s http://127.0.0.1:8080/healthz
```

---

## 8. Local image preview (optional)

You can build the **exact same** image locally to debug before pushing
to Fly:

```bash
docker build -t electromesh-api:local .
docker run --rm -p 8080:8080 \
  -e EM_ENV=dev \
  -e EM_DATABASE_URL="postgresql+psycopg://em:em@host.docker.internal:5432/electromesh" \
  -e EM_REDIS_URL="redis://host.docker.internal:6379/0" \
  -e EM_JWT_SECRET="local-only" \
  electromesh-api:local

curl http://127.0.0.1:8080/healthz
```

---

## 9. Common gotchas

* **`Permission denied` on `/app/scripts/fly-entrypoint.sh`** — the
  file must be executable on disk *before* `docker build` (or be
  `chmod +x`'d by the Dockerfile, which we do).
* **`relation "..." does not exist`** — alembic didn't run. Check the
  release-machine logs: `fly releases --app electromesh-api`.
* **`could not connect to server`** — Fly Postgres attaches a private
  IPv6 hostname; you must use the `postgres.flycast` hostname from
  `fly postgres attach`, NOT the public one.
* **Healthcheck failing immediately after deploy** — `start-period`
  in `fly.toml` is too short for your DB pool warm-up. Bump
  `grace_period = "30s"` → `"60s"`.

---

## 10. CI/CD (GitHub Actions)

Drop this into `.github/workflows/deploy.yml`:

```yaml
name: Deploy backend to Fly
on:
  push:
    branches: [main]
    paths: ['backend/**']

jobs:
  deploy:
    runs-on: ubuntu-latest
    concurrency: deploy-${{ github.ref }}
    steps:
      - uses: actions/checkout@v4
      - uses: superfly/flyctl-actions/setup-flyctl@master
      - run: flyctl deploy --remote-only --config backend/fly.toml
        working-directory: backend
        env:
          FLY_API_TOKEN: ${{ secrets.FLY_API_TOKEN }}
```

Get the token via `fly tokens create deploy -x 999999h`.
