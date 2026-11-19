"""Autenticación (sesiones con cookie) y autorización (roles admin/miembro).

- La cookie de sesión es HttpOnly + SameSite=Strict; en BD solo se guarda
  su hash.
- Toda petición que modifica datos exige la cabecera X-CSRF-Token.
- El primer administrador se crea con el token de instalación que el
  servidor imprime al arrancar (o con `python -m control_ia crear-usuario`).
"""

from __future__ import annotations

import secrets
from datetime import UTC, datetime, timedelta
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from pydantic import BaseModel, Field

from . import audit
from .context import AppContext, get_ctx
from .db import now_iso
from .security import hash_password, hash_token, verify_password

COOKIE_NAME = "cia_session"
SAFE_METHODS = {"GET", "HEAD", "OPTIONS"}

router = APIRouter(prefix="/api/auth", tags=["auth"])

# Validación sencilla de email sin depender de email-validator.
EMAIL = Field(pattern=r"^[^@\s]+@[^@\s]+\.[^@\s]+$", max_length=200)


class LoginIn(BaseModel):
    email: str = EMAIL
    password: str = Field(min_length=1, max_length=200)


class SetupIn(BaseModel):
    setup_token: str = Field(min_length=1, max_length=200)
    email: str = EMAIL
    name: str = Field(min_length=1, max_length=80)
    password: str = Field(min_length=10, max_length=200)


class UserCreateIn(BaseModel):
    email: str = EMAIL
    name: str = Field(min_length=1, max_length=80)
    password: str = Field(min_length=10, max_length=200)
    role: str = Field(pattern="^(admin|member)$", default="member")


class PasswordIn(BaseModel):
    current_password: str = Field(min_length=1, max_length=200)
    new_password: str = Field(min_length=10, max_length=200)


def public_user(user: dict[str, Any]) -> dict[str, Any]:
    return {k: user[k] for k in ("id", "email", "name", "role", "created_at")}


def create_user(ctx: AppContext, email: str, name: str, password: str, role: str) -> int:
    if ctx.db.one("SELECT id FROM users WHERE email = ?", (email,)):
        raise HTTPException(409, "Ya existe un usuario con ese email.")
    return ctx.db.execute(
        "INSERT INTO users (email, name, password_hash, role, created_at) VALUES (?, ?, ?, ?, ?)",
        (email, name, hash_password(password), role, now_iso()),
    )


def _start_session(ctx: AppContext, response: Response, user_id: int) -> str:
    token = secrets.token_urlsafe(32)
    csrf = secrets.token_urlsafe(24)
    expires = datetime.now(UTC) + timedelta(hours=ctx.settings.session_hours)
    ctx.db.execute(
        "INSERT INTO sessions (token_hash, user_id, csrf_token, created_at, expires_at)"
        " VALUES (?, ?, ?, ?, ?)",
        (hash_token(token), user_id, csrf, now_iso(), expires.isoformat(timespec="seconds")),
    )
    response.set_cookie(
        COOKIE_NAME,
        token,
        httponly=True,
        samesite="strict",
        secure=ctx.settings.cookie_secure,
        max_age=ctx.settings.session_hours * 3600,
        path="/",
    )
    return csrf


def _session_for(ctx: AppContext, request: Request) -> dict[str, Any] | None:
    token = request.cookies.get(COOKIE_NAME)
    if not token:
        return None
    row = ctx.db.one(
        "SELECT s.csrf_token, s.expires_at, u.* FROM sessions s JOIN users u ON u.id = s.user_id"
        " WHERE s.token_hash = ?",
        (hash_token(token),),
    )
    if not row:
        return None
    if datetime.fromisoformat(row["expires_at"]) < datetime.now(UTC):
        ctx.db.execute("DELETE FROM sessions WHERE token_hash = ?", (hash_token(token),))
        return None
    return row


def current_user(request: Request, ctx: AppContext = Depends(get_ctx)) -> dict[str, Any]:
    row = _session_for(ctx, request)
    if not row:
        raise HTTPException(401, "Sesión no iniciada o caducada. Vuelve a entrar.")
    if request.method not in SAFE_METHODS:
        sent = request.headers.get("X-CSRF-Token", "")
        if not secrets.compare_digest(sent, row["csrf_token"]):
            raise HTTPException(403, "Falta o no coincide el token CSRF. Recarga la página.")
    return row


def require_admin(user: dict[str, Any] = Depends(current_user)) -> dict[str, Any]:
    if user["role"] != "admin":
        raise HTTPException(403, "Esta acción requiere permisos de administrador.")
    return user


def _client_key(request: Request, email: str) -> str:
    host = request.client.host if request.client else "?"
    return f"{host}:{email.lower()}"


@router.get("/status")
def status(request: Request, ctx: AppContext = Depends(get_ctx)) -> dict[str, Any]:
    needs_setup = ctx.db.one("SELECT COUNT(*) AS n FROM users")["n"] == 0
    row = _session_for(ctx, request)
    return {
        "needs_setup": needs_setup,
        "user": public_user(row) if row else None,
        "csrf_token": row["csrf_token"] if row else None,
    }


@router.post("/setup")
def setup(body: SetupIn, request: Request, response: Response, ctx: AppContext = Depends(get_ctx)):
    if ctx.db.one("SELECT COUNT(*) AS n FROM users")["n"] > 0:
        raise HTTPException(409, "La instalación ya está hecha. Inicia sesión.")
    if ctx.login_limiter.hit(_client_key(request, "setup")):
        raise HTTPException(429, "Demasiados intentos. Espera un minuto.")
    if not secrets.compare_digest(body.setup_token.strip(), ctx.setup_token):
        audit.record(
            ctx.db,
            actor=body.email,
            action="auth.instalacion",
            result="denegado",
            detail="Token de instalación incorrecto",
        )
        raise HTTPException(403, "Token de instalación incorrecto. Míralo en el registro del servidor.")
    user_id = create_user(ctx, body.email, body.name, body.password, "admin")
    csrf = _start_session(ctx, response, user_id)
    audit.record(
        ctx.db,
        actor=body.email,
        user_id=user_id,
        action="auth.instalacion",
        detail="Primer administrador creado",
    )
    user = ctx.db.one("SELECT * FROM users WHERE id = ?", (user_id,))
    return {"user": public_user(user), "csrf_token": csrf}


@router.post("/login")
def login(body: LoginIn, request: Request, response: Response, ctx: AppContext = Depends(get_ctx)):
    key = _client_key(request, body.email)
    wait = ctx.login_limiter.hit(key)
    if wait:
        raise HTTPException(429, f"Demasiados intentos. Prueba de nuevo en {int(wait) + 1} s.")
    user = ctx.db.one("SELECT * FROM users WHERE email = ?", (body.email,))
    if not user or not verify_password(body.password, user["password_hash"]):
        audit.record(
            ctx.db, actor=body.email, action="auth.login", result="error", detail="Credenciales incorrectas"
        )
        # Mismo mensaje exista o no el usuario, para no revelar cuentas.
        raise HTTPException(401, "Email o contraseña incorrectos.")
    ctx.login_limiter.reset(key)
    csrf = _start_session(ctx, response, user["id"])
    audit.record(ctx.db, actor=user["email"], user_id=user["id"], action="auth.login")
    return {"user": public_user(user), "csrf_token": csrf}


@router.post("/logout")
def logout(
    request: Request, response: Response, user=Depends(current_user), ctx: AppContext = Depends(get_ctx)
):
    token = request.cookies.get(COOKIE_NAME, "")
    ctx.db.execute("DELETE FROM sessions WHERE token_hash = ?", (hash_token(token),))
    response.delete_cookie(COOKIE_NAME, path="/")
    audit.record(ctx.db, actor=user["email"], user_id=user["id"], action="auth.logout")
    return {"ok": True}


@router.post("/password")
def change_password(body: PasswordIn, user=Depends(current_user), ctx: AppContext = Depends(get_ctx)):
    if not verify_password(body.current_password, user["password_hash"]):
        raise HTTPException(400, "La contraseña actual no es correcta.")
    ctx.db.execute(
        "UPDATE users SET password_hash = ? WHERE id = ?", (hash_password(body.new_password), user["id"])
    )
    audit.record(ctx.db, actor=user["email"], user_id=user["id"], action="auth.cambiar_contraseña")
    return {"ok": True}


@router.get("/users")
def list_users(admin=Depends(require_admin), ctx: AppContext = Depends(get_ctx)):
    return [public_user(u) for u in ctx.db.all("SELECT * FROM users ORDER BY id")]


@router.post("/users")
def add_user(body: UserCreateIn, admin=Depends(require_admin), ctx: AppContext = Depends(get_ctx)):
    user_id = create_user(ctx, body.email, body.name, body.password, body.role)
    audit.record(
        ctx.db,
        actor=admin["email"],
        user_id=admin["id"],
        action="usuario.crear",
        target=body.email,
        detail=f"rol={body.role}",
    )
    return public_user(ctx.db.one("SELECT * FROM users WHERE id = ?", (user_id,)))
