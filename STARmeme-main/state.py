"""Persistencia del estado del bot.

Guarda en un JSON:
- seen: mints ya alertados (para no repetir la misma moneda).
- day / count_today: contador diario de alertas, para no saturar.
- historial: últimas llamadas hechas, usado por check_results_loop y por
  !resultados para saber si "petaron" después.

Antes esto era un dict global (`state`) manipulado directamente desde
Bot.py. Ahora es una clase para poder:
- Testearlo sin tocar disco (pasando un path temporal).
- Escribir de forma atómica (evita dejar el JSON a medias si el proceso
  muere justo al guardar).
"""

from __future__ import annotations

import json
import logging
import os
from datetime import datetime, timezone
from typing import Any

logger = logging.getLogger(__name__)

MAX_SEEN = 1000
MAX_HISTORIAL = 200


class StateStore:
    def __init__(self, path: str = "state.json") -> None:
        self._path = path
        self._data: dict[str, Any] = self._load()

    def _load(self) -> dict[str, Any]:
        data: dict[str, Any] = {}
        if os.path.exists(self._path):
            try:
                with open(self._path, "r", encoding="utf-8") as f:
                    data = json.load(f)
            except (json.JSONDecodeError, OSError) as exc:
                logger.warning(
                    "No se pudo leer %s (%s); se empieza con estado vacío.",
                    self._path,
                    exc,
                )
        data.setdefault("seen", [])
        data.setdefault("day", "")
        data.setdefault("count_today", 0)
        data.setdefault("historial", [])
        return data

    def _save(self) -> None:
        """Escritura atómica: escribe en un archivo temporal y renombra.

        Evita que un crash a mitad de escritura deje state.json corrupto
        (con json.load fallando en el próximo arranque).
        """
        tmp_path = f"{self._path}.tmp"
        with open(tmp_path, "w", encoding="utf-8") as f:
            json.dump(self._data, f)
        os.replace(tmp_path, self._path)

    # -- Tokens ya vistos -----------------------------------------------

    @property
    def seen(self) -> set[str]:
        return set(self._data["seen"])

    # -- Contador diario --------------------------------------------------

    def reset_counter_if_new_day(self) -> None:
        today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
        if self._data.get("day") != today:
            self._data["day"] = today
            self._data["count_today"] = 0
            self._save()

    def can_alert_today(self, max_per_day: int) -> bool:
        self.reset_counter_if_new_day()
        return self._data["count_today"] < max_per_day

    @property
    def count_today(self) -> int:
        return self._data["count_today"]

    # -- Registro de alertas enviadas -------------------------------------

    def mark_alert_sent(self, token: dict[str, Any]) -> None:
        mint = token.get("mint")
        self._data["seen"].append(mint)
        self._data["seen"] = self._data["seen"][-MAX_SEEN:]
        self._data["count_today"] += 1
        self._data["historial"].append(
            {
                "mint": mint,
                "symbol": token.get("symbol"),
                "market_cap_inicial": token.get("_market_cap", 0),
                "timestamp": datetime.now(timezone.utc).timestamp(),
                "celebrado": False,
            }
        )
        self._data["historial"] = self._data["historial"][-MAX_HISTORIAL:]
        self._save()

    # -- Historial / resultados -------------------------------------------

    @property
    def historial(self) -> list[dict[str, Any]]:
        return self._data["historial"]

    def save(self) -> None:
        self._save()
