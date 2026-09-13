"""Punto de entrada del bot. Uso: python main.py

Responsabilidades de este archivo, y solo estas:
1. Configurar logging.
2. Cargar Settings desde las variables de entorno.
3. Validar que la configuración mínima tenga sentido.
4. Arrancar el bot.

Toda la lógica real vive en config.py, state.py, sources.py, filters.py,
tweets.py y discord_bot.py.
"""

from __future__ import annotations

import logging

from config import load_settings, validate_settings
from discord_bot import create_bot


def main() -> None:
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
    )

    settings = load_settings()
    problemas = validate_settings(settings)
    if problemas:
        raise SystemExit("Configuración inválida:\n- " + "\n- ".join(problemas))

    bot = create_bot(settings)
    bot.run(settings.discord_token, log_handler=None)


if __name__ == "__main__":
    main()
