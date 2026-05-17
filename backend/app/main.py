from __future__ import annotations

from contextlib import asynccontextmanager

from fastapi import FastAPI, Response
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import ORJSONResponse

from app.api.v1 import api_router
from app.config import get_settings
from app.exceptions import ElectroMeshError
from app.logging_setup import configure_logging, get_logger
from app.observability.metrics import render_metrics
from app.observability.middleware import RequestObservabilityMiddleware


@asynccontextmanager
async def lifespan(app: FastAPI):  # type: ignore[no-untyped-def]
    configure_logging()
    log = get_logger("startup")
    settings = get_settings()
    log.info(
        "service.start",
        env=settings.env,
        service=settings.service_name,
        version=app.version,
    )
    yield
    log.info("service.stop")


def create_app() -> FastAPI:
    settings = get_settings()
    app = FastAPI(
        title="ElectroMesh API",
        version="0.1.0",
        default_response_class=ORJSONResponse,
        root_path=settings.api_root_path,
        lifespan=lifespan,
        docs_url="/docs" if not settings.is_prod else None,
        redoc_url=None,
    )

    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.cors_origins,
        allow_methods=["*"],
        allow_headers=["*"],
        allow_credentials=False,
    )
    app.add_middleware(RequestObservabilityMiddleware)

    app.include_router(api_router)

    @app.get("/healthz")
    async def healthz() -> dict:
        return {"status": "ok", "service": settings.service_name}

    @app.get("/readyz")
    async def readyz() -> dict:
        return {"status": "ready"}

    if settings.metrics_enabled:
        @app.get(settings.metrics_path, include_in_schema=False)
        async def metrics() -> Response:
            body, content_type = render_metrics()
            return Response(content=body, media_type=content_type)

    @app.exception_handler(ElectroMeshError)
    async def _domain_handler(_request, exc: ElectroMeshError):  # type: ignore[no-untyped-def]
        return ORJSONResponse(
            status_code=exc.http_status,
            content={"code": exc.code, "message": exc.message, **exc.detail},
        )

    return app


app = create_app()
