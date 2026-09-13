"""Generación de tweets — 100% gratis, sin ninguna API de IA de pago.

Combina ganchos + dato concreto + cierre, elegidos al azar, para que la
estructura no se repita siempre igual. Ver README para cómo cambiar a un
generador con IA (Gemini) si algún día interesa.
"""

from __future__ import annotations

import random
from typing import Any

Candidate = dict[str, Any]

HOOKS_ES = [
    "👀 Esto se está moviendo FUERTE en Solana:",
    "🚨 Alerta desde {link}, mirad esto:",
    "🔥 Esto está que arde ahora mismo:",
    "🧵 Uno pa' vigilar hoy, en serio:",
    "⚡ Acaba de aparecer en el radar:",
    "💣 Esto puede petar, atentos:",
    "🐸 Nueva joya (o trampa, ojo) en Solana:",
]

HOOKS_EN = [
    "👀 This one's moving FAST on Solana:",
    "🚨 Fresh alert straight from {link}:",
    "🔥 This is heating up right now:",
    "🧵 One to watch today, for real:",
    "⚡ Just popped up on the radar:",
    "💣 This could blow up, stay sharp:",
    "🐸 New gem (or trap, careful) on Solana:",
]

DATA_LINES_ES = [
    "${symbol} — market cap ${mcap} 📈",
    "${symbol} ya mueve ${mcap} de capitalización 💰",
    "${symbol}: ${mcap} de cap y ${vol} de volumen en 24h 🔥",
    "${symbol} pegando subidón: ${mcap} de cap ahora mismo 🚀",
]

DATA_LINES_EN = [
    "${symbol} — market cap ${mcap} 📈",
    "${symbol} already at ${mcap} market cap 💰",
    "${symbol}: ${mcap} cap, ${vol} volume in 24h 🔥",
    "${symbol} pumping hard: ${mcap} cap right now 🚀",
]

DESC_LINES_ES = [
    "La idea detrás: {desc}",
    "De qué va: {desc}",
    "El proyecto: {desc}",
]

DESC_LINES_EN = [
    "The idea behind it: {desc}",
    "What it's about: {desc}",
    "The project: {desc}",
]

CLOSERS_ES = [
    "¿Vosotros entráis o pasáis? NFA 👇",
    "Yo lo sigo de cerca, ojo con esto. NFA, DYOR 🧠",
    "Haced vuestra research antes de nada. NFA 🔍",
    "Que cada uno decida, esto es puro riesgo. NFA ⚠️",
    "A mí me tiene enganchado, veremos qué pasa. NFA 👀",
]

CLOSERS_EN = [
    "You in or you out? NFA 👇",
    "Keeping an eye on this one. NFA, DYOR 🧠",
    "Do your own research first. NFA 🔍",
    "Pure risk, decide for yourself. NFA ⚠️",
    "This one's got my attention, we'll see. NFA 👀",
]

HASHTAG_POOL_ES = [
    "#Solana", "#memecoin", "#pumpfun", "#cripto", "#altcoins",
    "#SolanaGems", "#memecoins", "#DeFi", "#Web3",
]
HASHTAG_POOL_EN = [
    "#Solana", "#memecoin", "#pumpfun", "#crypto", "#altcoins",
    "#SolanaGems", "#memecoins", "#DeFi", "#Web3",
]

VICTORY_HOOKS_ES = [
    "🏆 OS LO DIJE:",
    "📈 Actualización de una llamada anterior:",
    "🔥 Esto ya lo habíamos avisado:",
]
VICTORY_HOOKS_EN = [
    "🏆 TOLD YOU SO:",
    "📈 Update on a previous call:",
    "🔥 We called this one already:",
]

TWEET_MAX_LEN = 280
X_URL_WEIGHT = 23  # X cuenta cualquier URL como 23 caracteres, sea cual sea su longitud real


def format_usd(value: float) -> str:
    if value >= 1_000_000:
        return f"{value / 1_000_000:.1f}M"
    if value >= 1_000:
        return f"{value / 1_000:.0f}K"
    return f"{value:.0f}"


def generate_tweet(
    token: Candidate, lang: str = "es", axiom_referral_link: str = ""
) -> tuple[str, str | None]:
    """Genera el tweet con plantillas propias. lang: 'es' o 'en'.

    Devuelve (tweet, error) por compatibilidad con el resto del código,
    aunque en la práctica esta función no falla (no hace llamadas de red).
    """
    symbol = token.get("symbol", "???")
    market_cap = token.get("_market_cap", 0)
    volume_24h = token.get("_volume_24h", 0)
    description = (token.get("description") or "").strip()

    hooks, data_lines, desc_lines, closers, hashtag_pool = (
        (HOOKS_ES, DATA_LINES_ES, DESC_LINES_ES, CLOSERS_ES, HASHTAG_POOL_ES)
        if lang == "es"
        else (HOOKS_EN, DATA_LINES_EN, DESC_LINES_EN, CLOSERS_EN, HASHTAG_POOL_EN)
    )

    pumpfun_link = f"https://pump.fun/coin/{token.get('mint', '')}"
    lines = [random.choice(hooks).format(link=pumpfun_link)]

    data_line = random.choice(data_lines).format(
        symbol=symbol, mcap=format_usd(market_cap), vol=format_usd(volume_24h)
    )
    lines.append(data_line)

    if description:
        desc_short = description if len(description) <= 90 else description[:87] + "..."
        lines.append(random.choice(desc_lines).format(desc=desc_short))

    lines.append(random.choice(closers))
    lines.append(f"💊 {axiom_referral_link}")

    hashtags = " ".join(random.sample(hashtag_pool, k=4) + [f"#{symbol}"])
    lines.append(hashtags)

    tweet = "\n".join(lines)

    # Puede haber hasta 2 links distintos (pump.fun arriba, Axiom abajo);
    # restamos la longitud real de cada uno que aparezca y sumamos el peso
    # fijo de X por cada uno, para aproximar la longitud real del tweet.
    longitud_aprox = len(tweet)
    for link in {pumpfun_link, axiom_referral_link}:
        if not link:
            continue
        apariciones = tweet.count(link)
        longitud_aprox += apariciones * (X_URL_WEIGHT - len(link))

    if longitud_aprox > TWEET_MAX_LEN and description:
        desc_prefixes = ("La idea", "De qué", "El proyecto", "The idea", "What it's", "The project")
        lines = [l for l in lines if not l.startswith(desc_prefixes)]
        tweet = "\n".join(lines)

    return tweet, None


def generate_victory_tweet(
    symbol: str, pct_change: float, lang: str = "es", axiom_referral_link: str = ""
) -> str:
    hook = random.choice(VICTORY_HOOKS_ES if lang == "es" else VICTORY_HOOKS_EN)
    if lang == "es":
        body = f"${symbol} lleva un +{pct_change:.0f}% desde que lo compartimos aquí 🚀"
        closer = "Por esto merece la pena seguirnos. Más vienen. NFA 👀"
    else:
        body = f"${symbol} is up +{pct_change:.0f}% since we shared it here 🚀"
        closer = "This is why it pays to follow. More coming. NFA 👀"
    cta = f"💊 {axiom_referral_link}"
    return "\n".join([hook, body, closer, cta])
