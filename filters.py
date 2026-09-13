"""Filtrado y selección del mejor candidato entre las monedas encontradas.

Extraído de Bot.py para poder testearlo sin necesitar Discord ni red: recibe
una lista de candidatos ya normalizados (ver sources.py) y un Settings, y
devuelve el mejor o None.
"""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any

from config import Settings

Candidate = dict[str, Any]


def find_qualifying_token(
    candidates: list[Candidate],
    seen: set[str],
    settings: Settings,
    *,
    now_ms: float | None = None,
) -> tuple[Candidate | None, dict[str, int]]:
    """Devuelve (token, stats). token es None si ninguno cumple todo esto:

    - Liquidez real en un DEX (no solo el dato de pump.fun).
    - Volumen 24h mínimo.
    - Transacciones 24h mínimas (que compre/venda gente de verdad, no 1 solo).
    - Liquidez proporcional a la capitalización (si no, aunque "valga mucho"
      no se puede vender sin hundir el precio: señal de riesgo).
    - El par lleva un mínimo de minutos vivo (evita rugs de los primeros
      segundos).
    - El par tiene como máximo max_pair_age_days días (nada de monedas
      viejas que ya no mira nadie).
    - No está ya desplomándose (evita recomendar algo que acaba de caer
      fuerte).

    Entre las que cumplen, se elige la de mejor proyección: más gente
    operando (transacciones), precio aguantando o subiendo, y más volumen.
    """
    ahora_ms = now_ms if now_ms is not None else datetime.now(timezone.utc).timestamp() * 1000

    stats = {"total": len(candidates), "nuevos": 0, "cumplen": 0, "descartados_por_calidad": 0}
    qualifying: list[Candidate] = []

    for c in candidates:
        mint = c.get("mint")
        if not mint or mint in seen:
            continue
        stats["nuevos"] += 1

        market_cap = c.get("market_cap") or 0
        liquidity = c.get("liquidity") or 0
        volume_24h = c.get("volume_24h") or 0
        txns_24h = c.get("txns_24h") or 0
        pair_created_at = c.get("pair_created_at")
        price_change_h1 = c.get("price_change_h1")

        if liquidity < settings.min_liquidity_usd:
            continue
        if volume_24h < settings.min_volume_24h_usd:
            continue
        if txns_24h < settings.min_txns_24h:
            continue
        if market_cap < settings.min_market_cap_usd:
            continue
        if market_cap > 0 and (liquidity / market_cap) < settings.min_liq_mcap_ratio:
            stats["descartados_por_calidad"] += 1
            continue

        # Sin dato de edad del par no podemos confirmar que sea reciente,
        # así que se descarta en vez de asumir que vale.
        if not pair_created_at:
            stats["descartados_por_calidad"] += 1
            continue

        edad_minutos = (ahora_ms - pair_created_at) / 60_000
        if edad_minutos < settings.min_pair_age_minutes:
            stats["descartados_por_calidad"] += 1
            continue
        if edad_minutos > settings.max_pair_age_days * 24 * 60:
            stats["descartados_por_calidad"] += 1
            continue

        if price_change_h1 is not None and price_change_h1 <= -settings.max_drop_1h_pct:
            stats["descartados_por_calidad"] += 1
            continue

        stats["cumplen"] += 1
        c["_market_cap"] = market_cap
        c["_liquidity"] = liquidity
        c["_volume_24h"] = volume_24h
        c["_txns_24h"] = txns_24h
        c["_price_change_h1"] = price_change_h1 if price_change_h1 is not None else 0
        qualifying.append(c)

    if not qualifying:
        return None, stats

    qualifying.sort(
        key=lambda c: (c["_txns_24h"], c["_price_change_h1"], c["_volume_24h"]),
        reverse=True,
    )
    return qualifying[0], stats
