#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────────────────────
# fly-entrypoint.sh
#
# Tiny shim the container ENTRYPOINT points at. Lets us do "one-shot" setup
# work (e.g. printing build metadata, sanity-checking secrets) before
# uvicorn takes over via `exec "$@"`.
#
# DB migrations live in fly.toml's `[deploy].release_command`, which Fly
# runs on a dedicated release machine before any production traffic flips.
# Doing them here would race when scaling > 1 instance.
# ──────────────────────────────────────────────────────────────────────────────

set -euo pipefail

echo "[entrypoint] electromesh-api booting · region=${FLY_REGION:-local} machine=${FLY_MACHINE_ID:-local} env=${EM_ENV:-dev}"

# Surface common misconfig before uvicorn fails with a confusing traceback.
if [[ "${EM_ENV:-dev}" == "prod" ]]; then
  : "${EM_JWT_SECRET:?[entrypoint] EM_JWT_SECRET is required in prod}"
  : "${EM_DATABASE_URL:?[entrypoint] EM_DATABASE_URL is required in prod}"
  : "${EM_REDIS_URL:?[entrypoint] EM_REDIS_URL is required in prod}"
fi

# Fly injects PORT — make sure our defaults track it.
export EM_API_PORT="${PORT:-${EM_API_PORT:-8080}}"

exec "$@"
