from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.api.routes import api_router
from app.api.routes.health import router as health_router
from app.core.config import settings
from app.core.logging import configure_sensitive_log_redaction
from app.core.middleware import UnexpectedErrorMiddleware
from app.services.bootstrap import bootstrap_superadmin


def create_app() -> FastAPI:
    configure_sensitive_log_redaction()
    app = FastAPI(
        title=settings.app_name,
        version=settings.app_version,
        docs_url="/docs",
        redoc_url="/redoc",
    )

    app.add_middleware(UnexpectedErrorMiddleware)
    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.backend_cors_origins,
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )

    app.include_router(health_router)
    app.include_router(api_router, prefix="/api")

    @app.on_event("startup")
    async def startup() -> None:
        await bootstrap_superadmin()

    @app.get("/")
    async def root() -> dict[str, str]:
        return {
            "name": settings.app_name,
            "status": "ok",
            "version": settings.app_version,
            "docs": "/docs",
            "health": "/health",
        }

    return app


app = create_app()
