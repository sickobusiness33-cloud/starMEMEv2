"""Objeto con las dependencias compartidas de la app (settings, BD, cifrado...).

Se construye una vez en `create_app` y cada router lo obtiene con
`get_ctx(request)`. Los tests crean el suyo con un directorio temporal.
"""

from __future__ import annotations

import os
import secrets
from dataclasses import dataclass, field
from typing import TYPE_CHECKING

from fastapi import Request

from .db import Database
from .ratelimit import RateLimiter
from .security import SecretBox
from .settings import Settings

if TYPE_CHECKING:
    from .runs import RunManager


@dataclass
class AppContext:
    settings: Settings
    db: Database
    box: SecretBox
    login_limiter: RateLimiter
    run_limiter: RateLimiter
    setup_token: str = field(default_factory=lambda: secrets.token_urlsafe(18))
    runs: RunManager | None = None


def build_context(settings: Settings) -> AppContext:
    os.makedirs(settings.data_dir, exist_ok=True)
    return AppContext(
        settings=settings,
        db=Database(os.path.join(settings.data_dir, "control_ia.sqlite3")),
        box=SecretBox(settings.secret_key, settings.data_dir),
        login_limiter=RateLimiter(settings.login_attempts_per_minute, 60),
        run_limiter=RateLimiter(settings.runs_per_minute_per_user, 60),
    )


def get_ctx(request: Request) -> AppContext:
    return request.app.state.ctx
