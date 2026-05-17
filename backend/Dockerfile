# syntax=docker/dockerfile:1.6
# ──────────────────────────────────────────────────────────────────────────────
# ElectroMesh backend · production image (Fly.io target)
#
# Multi-stage build:
#   - `builder`  : compiles wheels w/ build-essential + libpq-dev
#   - `runtime`  : slim image with only the runtime libs + the wheels
#
# Why multi-stage:
#   * Final image stays ~170 MB instead of ~500 MB.
#   * Fly's free `shared-cpu-1x` builder is happy with smaller layers.
#   * Production has no compilers → smaller attack surface.
# ──────────────────────────────────────────────────────────────────────────────

ARG PYTHON_VERSION=3.11-slim-bookworm

# ── stage 1 ───────────────────────────────────────────────────────────────────
FROM python:${PYTHON_VERSION} AS builder

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PIP_ROOT_USER_ACTION=ignore

RUN apt-get update && apt-get install -y --no-install-recommends \
        build-essential libpq-dev \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /build

# Cache layer: copy only the manifest first so dependency installs aren't
# busted every time a source file changes.
COPY pyproject.toml ./

RUN pip wheel --wheel-dir=/wheels \
    "fastapi>=0.110" "uvicorn[standard]>=0.29" \
    "pydantic[email]>=2.6" "pydantic-settings>=2.2" \
    "sqlalchemy>=2.0" "alembic>=1.13" "asyncpg>=0.29" "psycopg[binary]>=3.1" \
    "redis>=5.0" "celery>=5.3" "httpx>=0.27" \
    "passlib[bcrypt]>=1.7.4" "bcrypt<5" "python-jose[cryptography]>=3.3" \
    "python-multipart>=0.0.9" "orjson>=3.10" "structlog>=24.1" \
    "prometheus-client>=0.20" "tenacity>=8.2" "stripe>=9.0" \
    "cryptography>=42.0" "websockets>=12.0" "anyio>=4.3" \
    "pyjwt>=2.8" "ulid-py>=1.1"

# ── stage 2 ───────────────────────────────────────────────────────────────────
FROM python:${PYTHON_VERSION} AS runtime

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PIP_ROOT_USER_ACTION=ignore \
    PORT=8080 \
    EM_API_HOST=0.0.0.0 \
    EM_API_PORT=8080

# Only runtime libs — no compilers in the final image.
RUN apt-get update && apt-get install -y --no-install-recommends \
        libpq5 curl ca-certificates tini \
    && rm -rf /var/lib/apt/lists/*

# Non-root user. Fly runs as root by default but we drop privileges so the
# container is happy on other targets too.
RUN useradd --create-home --shell /bin/bash --uid 10001 app
WORKDIR /app

COPY --from=builder /wheels /wheels
RUN pip install --no-index --find-links=/wheels /wheels/*.whl \
    && rm -rf /wheels

# Application source.
COPY --chown=app:app . .

RUN chmod +x /app/scripts/fly-entrypoint.sh 2>/dev/null || true

USER app

EXPOSE 8080

# Local Docker healthcheck (Fly also runs its own from fly.toml).
HEALTHCHECK --interval=15s --timeout=4s --start-period=20s --retries=4 \
  CMD curl -fsS "http://127.0.0.1:${PORT:-8080}/healthz" || exit 1

ENTRYPOINT ["/usr/bin/tini", "--", "/app/scripts/fly-entrypoint.sh"]
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8080", "--proxy-headers", "--forwarded-allow-ips", "*"]
