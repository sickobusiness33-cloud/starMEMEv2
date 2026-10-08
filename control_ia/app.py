"""Composición de la app FastAPI: routers, cabeceras de seguridad y estáticos."""

from __future__ import annotations

import logging
import os
from contextlib import asynccontextmanager
from typing import Any

from fastapi import Depends, FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from starlette.exceptions import HTTPException as StarletteHTTPException

from . import audit, auth, projects, runs
from .auth import current_user
from .connectors import CONNECTOR_CLASSES
from .connectors import api as connectors_api
from .context import AppContext, build_context, get_ctx
from .providers import api as providers_api
from .security import install_log_redaction, redact
from .settings import Settings, load_settings
from .tools import RISK_LABELS, TOOLS

logger = logging.getLogger(__name__)
STATIC_DIR = os.path.join(os.path.dirname(__file__), "static")

CSP = (
    "default-src 'self'; script-src 'self'; style-src 'self' https://fonts.googleapis.com; "
    "font-src 'self' https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'; "
    "frame-ancestors 'none'; base-uri 'none'; form-action 'self'"
)

FIELD_NAMES = {
    "name": "nombre",
    "email": "email",
    "password": "contraseña",
    "input": "mensaje",
    "description": "descripción",
    "instructions": "instrucciones",
    "model": "modelo",
}


def _validation_message(exc: RequestValidationError) -> str:
    parts = []
    for err in exc.errors()[:5]:
        field = str(err.get("loc", ["?"])[-1])
        label = FIELD_NAMES.get(field, field)
        kind = err.get("type", "")
        if kind == "string_too_short":
            parts.append(f"«{label}» es demasiado corto (mín. {err.get('ctx', {}).get('min_length')}).")
        elif kind == "string_too_long":
            parts.append(f"«{label}» es demasiado largo (máx. {err.get('ctx', {}).get('max_length')}).")
        elif kind == "string_pattern_mismatch":
            parts.append(f"«{label}» no tiene un formato válido.")
        elif kind == "missing":
            parts.append(f"Falta «{label}».")
        else:
            parts.append(f"«{label}»: valor no válido.")
    return " ".join(parts) or "Datos no válidos."


def create_app(settings: Settings | None = None, ctx: AppContext | None = None) -> FastAPI:
    settings = settings or load_settings()
    ctx = ctx or build_context(settings)

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        install_log_redaction()
        ctx.runs = runs.RunManager(ctx)
        ctx.runs.recover()
        if ctx.db.one("SELECT COUNT(*) AS n FROM users")["n"] == 0:
            logger.warning(
                "No hay usuarios. Abre la app y usa este token de instalación para crear el "
                "administrador: %s",
                ctx.setup_token,
            )
        yield
        await ctx.runs.shutdown()

    app = FastAPI(title="Control IA", lifespan=lifespan, docs_url=None, redoc_url=None, openapi_url=None)
    app.state.ctx = ctx

    @app.middleware("http")
    async def security_headers(request: Request, call_next):
        response = await call_next(request)
        response.headers["Content-Security-Policy"] = CSP
        response.headers["X-Content-Type-Options"] = "nosniff"
        response.headers["X-Frame-Options"] = "DENY"
        response.headers["Referrer-Policy"] = "no-referrer"
        if request.url.path.startswith("/api/"):
            response.headers["Cache-Control"] = "no-store"
        return response

    @app.exception_handler(StarletteHTTPException)
    async def http_error(request: Request, exc: StarletteHTTPException):
        return JSONResponse({"error": redact(exc.detail)}, status_code=exc.status_code)

    @app.exception_handler(RequestValidationError)
    async def validation_error(request: Request, exc: RequestValidationError):
        return JSONResponse({"error": _validation_message(exc)}, status_code=422)

    @app.exception_handler(Exception)
    async def unexpected(request: Request, exc: Exception):
        logger.exception("Error no controlado en %s %s", request.method, request.url.path)
        return JSONResponse(
            {"error": "Error interno del servidor. Se ha registrado para revisarlo."}, status_code=500
        )

    for router in (auth.router, projects.router, runs.router, connectors_api.router, providers_api.router):
        app.include_router(router)

    @app.get("/api/activity")
    def activity(
        q: str = "",
        result: str = "",
        project_id: int | None = None,
        user=Depends(current_user),
        c: AppContext = Depends(get_ctx),
    ) -> list[dict[str, Any]]:
        return audit.list_entries(c.db, user=user, project_id=project_id, query=q, result=result)

    @app.get("/api/catalog")
    def catalog(user=Depends(current_user), c: AppContext = Depends(get_ctx)) -> dict[str, Any]:
        """Configuración pública + catálogo de herramientas y conectores. Sin secretos."""
        return {
            "settings": c.settings.public_dict(),
            "tools": [t.as_dict() for t in TOOLS.values()],
            "risk_labels": RISK_LABELS,
            "connector_types": [cls.type.as_dict() for cls in CONNECTOR_CLASSES.values()],
            "colors": projects.COLORS,
        }

    @app.get("/healthz")
    def healthz() -> dict[str, str]:
        return {"status": "ok"}

    app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")

    @app.get("/")
    def index() -> FileResponse:
        return FileResponse(os.path.join(STATIC_DIR, "index.html"))

    return app
