"""Fuentes de datos de meme coins de Solana.

pump.fun bloquea muchas veces a servidores (Railway, AWS, etc). Por eso este
archivo usa VARIAS fuentes a la vez, para no depender de una sola:

1. pump.fun directo (best-effort — si falla, no pasa nada, se ignora).
2. DexScreener "token boosts" (tokens que están recibiendo promoción activa,
   señal fuerte de que hay actividad real). Gratis, sin API key.
3. DexScreener "búsqueda" por palabras clave de Solana, como red de
   seguridad para no quedarnos sin candidatos.

Cada función devuelve una lista de diccionarios ya normalizados con estas
claves: mint, name, symbol, description, market_cap, liquidity, volume_24h,
txns_24h, pair_created_at, price_change_h1, source (de dónde salió el dato).
"""

from __future__ import annotations

import logging
import time
from concurrent.futures import ThreadPoolExecutor
from typing import Any

import requests

logger = logging.getLogger(__name__)

HEADERS = {"User-Agent": "Mozilla/5.0 (StarMemeBot/1.0)"}
TIMEOUT = 10
RETRIES = 2
RETRY_BACKOFF_SECONDS = 0.5
VERIFY_WORKERS = 8  # cuántas verificaciones DexScreener en paralelo, para no tardar minutos

PUMPFUN_API = "https://frontend-api.pump.fun/coins"
DEXSCREENER_BOOSTS = "https://api.dexscreener.com/token-boosts/latest/v1"
DEXSCREENER_TOKENS = "https://api.dexscreener.com/tokens/v1/solana/"
DEXSCREENER_SEARCH = "https://api.dexscreener.com/latest/dex/search"

Candidate = dict[str, Any]

# Sesión compartida: reutiliza conexiones TCP/TLS en vez de abrir una nueva
# por cada petición (relevante porque from_pumpfun/from_dexscreener_boosts
# hacen muchas peticiones seguidas a DexScreener).
_session = requests.Session()


def _get(url: str, params: dict[str, Any] | None = None) -> Any | None:
    last_exc: Exception | None = None
    for attempt in range(RETRIES + 1):
        try:
            r = _session.get(url, params=params, headers=HEADERS, timeout=TIMEOUT)
            r.raise_for_status()
            return r.json()
        except requests.RequestException as exc:
            last_exc = exc
            if attempt < RETRIES:
                time.sleep(RETRY_BACKOFF_SECONDS * (attempt + 1))
    logger.warning("Error consultando %s tras %d intentos: %s", url, RETRIES + 1, last_exc)
    return None


def _pair_to_candidate(pair: dict[str, Any], source: str) -> Candidate:
    base = pair.get("baseToken") or {}
    liquidity = (pair.get("liquidity") or {}).get("usd", 0) or 0
    volume_24h = (pair.get("volume") or {}).get("h24", 0) or 0
    market_cap = pair.get("marketCap") or pair.get("fdv") or 0
    txns_h24 = (pair.get("txns") or {}).get("h24") or {}
    txns_total = (txns_h24.get("buys") or 0) + (txns_h24.get("sells") or 0)
    pair_created_at = pair.get("pairCreatedAt")  # timestamp en ms, o None
    price_change_h1 = (pair.get("priceChange") or {}).get("h1")
    return {
        "source": source,
        "mint": base.get("address"),
        "name": base.get("name"),
        "symbol": base.get("symbol"),
        "description": "",
        "market_cap": market_cap,
        "liquidity": liquidity,
        "volume_24h": volume_24h,
        "txns_24h": txns_total,
        "pair_created_at": pair_created_at,
        "price_change_h1": price_change_h1,
    }


def from_pumpfun(limit: int = 30) -> list[Candidate]:
    """pump.fun directo, pero VERIFICADO contra DexScreener antes de devolverlo.

    pump.fun por sí solo se puede inflar con una sola persona comprando (el
    market cap sube con la curva, no hace falta que haya nadie más). Por eso
    aquí no nos fiamos del dato de pump.fun a solas: para cada moneda,
    comprobamos en DexScreener que tiene liquidez y transacciones reales.
    Si no aparece en DexScreener todavía, la descartamos (demasiado pronto
    para saber si es real o no).
    """
    data = _get(PUMPFUN_API, {"offset": 0, "limit": limit, "sort": "market_cap", "order": "DESC"})
    if not data:
        return []

    tokens = [t for t in data if t.get("mint")]

    def verify(t: dict[str, Any]) -> Candidate | None:
        mint = t["mint"]
        pairs = _get(f"{DEXSCREENER_TOKENS}{mint}")
        if not pairs:
            return None  # sin rastro en ningún DEX todavía -> no verificable, se descarta
        best_pair = max(pairs, key=lambda p: (p.get("liquidity") or {}).get("usd", 0) or 0)
        candidate = _pair_to_candidate(best_pair, "pumpfun_verificado")
        candidate["description"] = t.get("description") or ""
        return candidate

    # Verificamos cada token contra DexScreener EN PARALELO: son peticiones
    # independientes, y hacerlas una a una (hasta 30, con timeout de 10s cada
    # una) podría tardar minutos si alguna fuente va lenta.
    with ThreadPoolExecutor(max_workers=VERIFY_WORKERS) as pool:
        results = pool.map(verify, tokens)
    return [c for c in results if c is not None]


def from_dexscreener_boosts() -> list[Candidate]:
    """Tokens de Solana con promoción activa pagada en DexScreener."""
    data = _get(DEXSCREENER_BOOSTS)
    if not data:
        return []

    addresses = [
        item.get("tokenAddress")
        for item in data
        if item.get("chainId") == "solana" and item.get("tokenAddress")
    ]

    def fetch(token_address: str) -> Candidate | None:
        pairs = _get(f"{DEXSCREENER_TOKENS}{token_address}")
        if not pairs:
            return None
        best_pair = max(pairs, key=lambda p: (p.get("liquidity") or {}).get("usd", 0) or 0)
        return _pair_to_candidate(best_pair, "dexscreener_boost")

    with ThreadPoolExecutor(max_workers=VERIFY_WORKERS) as pool:
        results = pool.map(fetch, addresses)
    return [c for c in results if c is not None]


def from_dexscreener_search(query: str = "solana meme") -> list[Candidate]:
    """Red de seguridad: búsqueda directa de pares de Solana en DexScreener."""
    data = _get(DEXSCREENER_SEARCH, {"q": query})
    if not data:
        return []

    pairs = data.get("pairs") or []
    out = []
    for pair in pairs:
        if pair.get("chainId") != "solana":
            continue
        out.append(_pair_to_candidate(pair, "dexscreener_search"))
    return out


def get_all_candidates() -> list[Candidate]:
    """Junta todas las fuentes en una sola lista, sin duplicados por mint."""
    candidates: list[Candidate] = []
    candidates += from_pumpfun()
    candidates += from_dexscreener_boosts()
    candidates += from_dexscreener_search("solana meme")
    candidates += from_dexscreener_search("pump.fun")

    # Quitamos duplicados por mint, quedándonos con el que tenga más datos
    # (aproximado: el de mayor liquidez reportada).
    by_mint: dict[str, Candidate] = {}
    for c in candidates:
        mint = c.get("mint")
        if not mint:
            continue
        if mint not in by_mint or (c.get("liquidity") or 0) > (by_mint[mint].get("liquidity") or 0):
            by_mint[mint] = c

    return list(by_mint.values())


def get_current_stats(mint: str) -> Candidate | None:
    """Datos actuales (cap, liquidez, volumen) de un mint ya conocido. None si no se encuentra."""
    pairs = _get(f"{DEXSCREENER_TOKENS}{mint}")
    if not pairs:
        return None
    best_pair = max(pairs, key=lambda p: (p.get("liquidity") or {}).get("usd", 0) or 0)
    return _pair_to_candidate(best_pair, "seguimiento")


def find_token_by_query(query: str) -> Candidate | None:
    """Busca UN token concreto por dirección de contrato, símbolo o nombre.

    Si 'query' parece una dirección de Solana (32-44 caracteres, sin
    espacios), se consulta directo por dirección. Si no, se hace una
    búsqueda por texto y se devuelve el par de mayor liquidez que coincida.
    """
    query = query.strip().lstrip("$").lstrip("@")

    es_direccion = 32 <= len(query) <= 44 and " " not in query
    if es_direccion:
        pairs = _get(f"{DEXSCREENER_TOKENS}{query}")
        if pairs:
            best_pair = max(pairs, key=lambda p: (p.get("liquidity") or {}).get("usd", 0) or 0)
            return _pair_to_candidate(best_pair, "manual")

    data = _get(DEXSCREENER_SEARCH, {"q": query})
    if not data:
        return None

    pairs = [p for p in (data.get("pairs") or []) if p.get("chainId") == "solana"]
    if not pairs:
        return None

    # Priorizamos coincidencia exacta de símbolo, si la hay.
    exactos = [p for p in pairs if (p.get("baseToken") or {}).get("symbol", "").lower() == query.lower()]
    pool = exactos or pairs
    best_pair = max(pool, key=lambda p: (p.get("liquidity") or {}).get("usd", 0) or 0)
    return _pair_to_candidate(best_pair, "manual")
