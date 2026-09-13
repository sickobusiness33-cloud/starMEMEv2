from tweets import format_usd, generate_tweet, generate_victory_tweet

TOKEN = {
    "symbol": "DOGE2",
    "mint": "So11111111111111111111111111111111111111",
    "description": "Un perrito solano que va a la luna.",
    "_market_cap": 120_000,
    "_volume_24h": 45_000,
}


def test_format_usd_millones():
    assert format_usd(2_500_000) == "2.5M"


def test_format_usd_miles():
    assert format_usd(45_000) == "45K"


def test_format_usd_pequeno():
    assert format_usd(500) == "500"


def test_generate_tweet_incluye_symbol_y_link():
    # El link de pump.fun solo aparece en algunos ganchos (elegidos al azar),
    # así que solo comprobamos lo que SIEMPRE está: símbolo y link de Axiom.
    tweet, error = generate_tweet(TOKEN, lang="es", axiom_referral_link="https://axiom.trade/@x")
    assert error is None
    assert "DOGE2" in tweet
    assert "axiom.trade" in tweet


def test_generate_tweet_respeta_280_caracteres_aprox():
    # X cuenta cada URL como 23 caracteres, así que el largo real del texto
    # puede superar 280 sin que el tweet sea inválido; comprobamos que la
    # función al menos intenta recortar la descripción cuando hace falta.
    token = dict(TOKEN)
    token["description"] = "x" * 200
    tweet, _ = generate_tweet(token, lang="es", axiom_referral_link="https://axiom.trade/@x")
    assert "x" * 200 not in tweet


def test_generate_tweet_en_ingles_usa_plantillas_en():
    tweet, _ = generate_tweet(TOKEN, lang="en", axiom_referral_link="https://axiom.trade/@x")
    assert "NFA" in tweet


def test_generate_victory_tweet_incluye_porcentaje():
    tweet = generate_victory_tweet("DOGE2", 87, lang="es", axiom_referral_link="https://axiom.trade/@x")
    assert "+87%" in tweet
    assert "DOGE2" in tweet
