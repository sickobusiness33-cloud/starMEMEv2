"""Configuración centralizada del bot.

Todo lo que antes eran variables sueltas en Bot.py ahora vive en un único
objeto Settings, cargado una vez desde las variables de entorno. Así:
- Es fácil ver de un vistazo qué se puede configurar y con qué valor por
  defecto.
- El resto de módulos no dependen de os.environ directamente, lo que los
  hace más fáciles de testear (se les pasa un Settings de prueba).
"""

from __future__ import annotations

import os
from dataclasses import dataclass


def _get_float(name: str, default: float) -> float:
    return float(os.getenv(name, str(default)))


def _get_int(name: str, default: int) -> int:
    return int(os.getenv(name, str(default)))


@dataclass(frozen=True)
class Settings:
    discord_token: str
    discord_channel_id: int

    # Filtros de calidad para considerar un token "candidato válido"
    min_market_cap_usd: float
    min_liquidity_usd: float
    min_volume_24h_usd: float
    min_txns_24h: int
    min_liq_mcap_ratio: float
    min_pair_age_minutes: float
    max_pair_age_days: float
    max_drop_1h_pct: float

    max_alerts_per_day: int
    check_interval_seconds: int
    axiom_referral_link: str

    # Seguimiento de resultados de llamadas pasadas ("os lo dije")
    result_celebrate_pct: float
    result_min_age_hours: float
    result_max_age_days: float

    state_file: str = "state.json"


def load_settings() -> Settings:
    """Lee todas las variables de entorno y devuelve un Settings inmutable.

    No valida DISCORD_TOKEN aquí a propósito: main.py decide qué hacer si
    falta, para que este módulo se pueda importar (y testear) sin necesitar
    el token configurado.
    """
    return Settings(
        discord_token=os.getenv("DISCORD_TOKEN", ""),
        discord_channel_id=_get_int("DISCORD_CHANNEL_ID", 0),
        min_market_cap_usd=_get_float("MIN_MARKET_CAP_USD", 30_000),
        min_liquidity_usd=_get_float("MIN_LIQUIDITY_USD", 15_000),
        min_volume_24h_usd=_get_float("MIN_VOLUME_24H_USD", 20_000),
        min_txns_24h=_get_int("MIN_TXNS_24H", 100),
        min_liq_mcap_ratio=_get_float("MIN_LIQ_MCAP_RATIO", 0.03),
        min_pair_age_minutes=_get_float("MIN_PAIR_AGE_MINUTES", 15),
        max_pair_age_days=_get_float("MAX_PAIR_AGE_DAYS", 5),
        max_drop_1h_pct=_get_float("MAX_DROP_1H_PCT", 30),
        max_alerts_per_day=_get_int("MAX_ALERTS_PER_DAY", 10),
        check_interval_seconds=_get_int("CHECK_INTERVAL_SECONDS", 300),
        axiom_referral_link=os.getenv(
            "AXIOM_REFERRAL_LINK", "https://axiom.trade/@sickopump"
        ),
        result_celebrate_pct=_get_float("RESULT_CELEBRATE_PCT", 50),
        result_min_age_hours=_get_float("RESULT_MIN_AGE_HOURS", 6),
        result_max_age_days=_get_float("RESULT_MAX_AGE_DAYS", 7),
        state_file=os.getenv("STATE_FILE", "state.json"),
    )


def validate_settings(settings: Settings) -> list[str]:
    """Devuelve una lista de problemas de configuración (vacía si todo bien).

    Fallar rápido y con un mensaje claro en el arranque es mejor que
    descubrir, minutos después, que el bot está corriendo pero nunca manda
    nada porque DISCORD_CHANNEL_ID se quedó en 0.
    """
    problemas = []
    if not settings.discord_token:
        problemas.append("Falta DISCORD_TOKEN en las variables de entorno.")
    if settings.discord_channel_id == 0:
        problemas.append("Falta DISCORD_CHANNEL_ID (o vale 0) en las variables de entorno.")
    if settings.check_interval_seconds <= 0:
        problemas.append("CHECK_INTERVAL_SECONDS debe ser mayor que 0.")
    if settings.max_alerts_per_day <= 0:
        problemas.append("MAX_ALERTS_PER_DAY debe ser mayor que 0.")
    return problemas
