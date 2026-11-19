"""Punto de entrada de Control IA.

Uso:
    python -m control_ia                     # arranca el servidor web
    python -m control_ia crear-usuario EMAIL [--admin]
    python -m control_ia demo                # crea proyectos de demostración
"""

from __future__ import annotations

import argparse
import getpass
import logging
import sys

from .settings import load_settings, validate_settings


def _serve() -> None:
    import uvicorn

    from .app import create_app

    settings = load_settings()
    problemas = validate_settings(settings)
    if problemas:
        raise SystemExit("Configuración inválida:\n- " + "\n- ".join(problemas))
    uvicorn.run(create_app(settings), host=settings.host, port=settings.port, log_config=None)


def _create_user(email: str, admin: bool) -> None:
    from .auth import create_user
    from .context import build_context

    ctx = build_context(load_settings())
    name = input("Nombre visible: ").strip() or email.split("@")[0]
    password = getpass.getpass("Contraseña (mín. 10 caracteres): ")
    if len(password) < 10:
        raise SystemExit("La contraseña debe tener al menos 10 caracteres.")
    create_user(ctx, email, name, password, "admin" if admin else "member")
    print(f"Usuario {email} creado ({'admin' if admin else 'miembro'}).")


def _demo() -> None:
    from .context import build_context
    from .demo_data import seed_demo

    ctx = build_context(load_settings())
    print(seed_demo(ctx))


def main(argv: list[str] | None = None) -> None:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(name)s: %(message)s")
    from .security import install_log_redaction

    install_log_redaction()
    parser = argparse.ArgumentParser(prog="python -m control_ia")
    sub = parser.add_subparsers(dest="cmd")
    cu = sub.add_parser("crear-usuario", help="Crea un usuario desde la terminal.")
    cu.add_argument("email")
    cu.add_argument("--admin", action="store_true")
    sub.add_parser("demo", help="Crea proyectos de demostración (marcados como DEMO) para el primer admin.")
    args = parser.parse_args(argv)
    if args.cmd == "crear-usuario":
        _create_user(args.email, args.admin)
    elif args.cmd == "demo":
        _demo()
    else:
        _serve()


if __name__ == "__main__":
    main(sys.argv[1:])
