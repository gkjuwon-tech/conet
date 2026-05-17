FROM python:3.11-slim

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1

RUN apt-get update && apt-get install -y --no-install-recommends \
        build-essential libpq-dev curl \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY pyproject.toml ./
RUN pip install \
    "fastapi>=0.110" "uvicorn[standard]>=0.29" \
    "pydantic[email]>=2.6" "pydantic-settings>=2.2" \
    "sqlalchemy>=2.0" "alembic>=1.13" "asyncpg>=0.29" "psycopg[binary]>=3.1" \
    "redis>=5.0" "celery>=5.3" "httpx>=0.27" \
    "passlib[bcrypt]>=1.7.4" "bcrypt<5" "python-jose[cryptography]>=3.3" \
    "python-multipart>=0.0.9" "orjson>=3.10" "structlog>=24.1" \
    "prometheus-client>=0.20" "tenacity>=8.2" "stripe>=9.0" \
    "cryptography>=42.0" "websockets>=12.0" "anyio>=4.3" \
    "pyjwt>=2.8" "ulid-py>=1.1"

COPY . .

EXPOSE 8080
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8080"]
