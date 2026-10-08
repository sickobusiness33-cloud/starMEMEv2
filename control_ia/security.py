"""Primitivas de seguridad: contraseñas, cifrado de secretos y redacción.

- Contraseñas: hashlib.scrypt (stdlib) con sal aleatoria.
- Secretos de conectores/proveedores: cifrados con Fernet (AES-128-CBC +
  HMAC). La clave viene de CONTROL_SECRET_KEY o, en local, de un archivo
  `secret.key` generado con permisos 0600 dentro del directorio de datos.
- Redacción: cualquier valor secreto descifrado se registra en memoria para
  poder borrarlo de errores y logs, además de patrones típicos de tokens.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import logging
import os
import re
import secrets
import threading

from cryptography.fernet import Fernet, InvalidToken

logger = logging.getLogger(__name__)

# --- Contraseñas --------------------------------------------------------

_SCRYPT = {"n": 2**14, "r": 8, "p": 1, "dklen": 32}


def hash_password(password: str) -> str:
    salt = secrets.token_bytes(16)
    digest = hashlib.scrypt(password.encode(), salt=salt, **_SCRYPT)
    return "scrypt$" + base64.b64encode(salt).decode() + "$" + base64.b64encode(digest).decode()


def verify_password(password: str, stored: str) -> bool:
    try:
        scheme, salt_b64, digest_b64 = stored.split("$")
    except ValueError:
        return False
    if scheme != "scrypt":
        return False
    digest = hashlib.scrypt(password.encode(), salt=base64.b64decode(salt_b64), **_SCRYPT)
    return hmac.compare_digest(digest, base64.b64decode(digest_b64))


def hash_token(token: str) -> str:
    """Las cookies de sesión se guardan hasheadas: una copia de la BD no sirve para entrar."""
    return hashlib.sha256(token.encode()).hexdigest()


# --- Redacción ----------------------------------------------------------

_known_secrets: set[str] = set()
_known_lock = threading.Lock()

_SECRET_PATTERNS = [
    re.compile(r"sk-ant-[A-Za-z0-9_\-]{8,}"),
    re.compile(r"sk-[A-Za-z0-9_\-]{16,}"),
    re.compile(r"gh[pousr]_[A-Za-z0-9]{20,}"),
    re.compile(r"github_pat_[A-Za-z0-9_]{20,}"),
    re.compile(r"xox[abprs]-[A-Za-z0-9\-]{10,}"),
    re.compile(r"(discord(?:app)?\.com/api/webhooks/)\d+/[A-Za-z0-9_\-]+"),
    re.compile(r"(hooks\.slack\.com/services/)[A-Za-z0-9/]+"),
    re.compile(r"(?i)(bearer\s+)[A-Za-z0-9._\-]{12,}"),
]

REDACTED = "[secreto oculto]"


def register_secret(value: str) -> None:
    if value and len(value) >= 6:
        with _known_lock:
            _known_secrets.add(value)


def redact(text: object) -> str:
    """Devuelve `text` sin secretos conocidos ni patrones de tokens."""
    if text is None:
        return ""
    out = str(text)
    with _known_lock:
        known = sorted(_known_secrets, key=len, reverse=True)
    for value in known:
        if value in out:
            out = out.replace(value, REDACTED)
    for pattern in _SECRET_PATTERNS:
        if pattern.groups:
            out = pattern.sub(lambda m: m.group(1) + REDACTED, out)
        else:
            out = pattern.sub(REDACTED, out)
    return out


class RedactingFilter(logging.Filter):
    """Filtro de logging: ningún secreto llega a los registros aunque un
    módulo (o una librería) intente loguear una excepción que lo contenga."""

    def filter(self, record: logging.LogRecord) -> bool:
        try:
            message = record.getMessage()
        except Exception:  # noqa: BLE001 - un log mal formado no debe romper nada
            return True
        record.msg = redact(message)
        record.args = ()
        if record.exc_info:
            import traceback

            record.exc_text = redact("".join(traceback.format_exception(*record.exc_info)))
            record.exc_info = None
        return True


def install_log_redaction() -> None:
    root = logging.getLogger()
    for handler in root.handlers:
        if not any(isinstance(f, RedactingFilter) for f in handler.filters):
            handler.addFilter(RedactingFilter())


# --- Cifrado de secretos -------------------------------------------------


class SecretBox:
    def __init__(self, key: str, data_dir: str) -> None:
        if not key:
            key = self._load_or_create_local_key(data_dir)
        try:
            self._fernet = Fernet(key.encode() if isinstance(key, str) else key)
        except (ValueError, TypeError) as exc:
            raise SystemExit(
                "CONTROL_SECRET_KEY no es una clave Fernet válida. Genera una con:\n"
                '  python -c "from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())"'
            ) from exc

    @staticmethod
    def _load_or_create_local_key(data_dir: str) -> str:
        path = os.path.join(data_dir, "secret.key")
        if os.path.exists(path):
            with open(path, encoding="utf-8") as f:
                return f.read().strip()
        os.makedirs(data_dir, exist_ok=True)
        key = Fernet.generate_key().decode()
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            f.write(key)
        logger.warning(
            "CONTROL_SECRET_KEY no está definida: se generó una clave local en %s. "
            "En producción define CONTROL_SECRET_KEY y guarda ese valor fuera del servidor.",
            path,
        )
        return key

    def encrypt(self, values: dict[str, str]) -> bytes:
        return self._fernet.encrypt(json.dumps(values).encode())

    def decrypt(self, blob: bytes | None) -> dict[str, str]:
        if not blob:
            return {}
        try:
            values = json.loads(self._fernet.decrypt(blob).decode())
        except InvalidToken:
            logger.error("No se pudieron descifrar secretos guardados (¿cambió CONTROL_SECRET_KEY?).")
            return {}
        for value in values.values():
            register_secret(str(value))
        return values
