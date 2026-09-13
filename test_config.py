from config import Settings, validate_settings

BASE = dict(
    discord_token="x",
    discord_channel_id=123,
    min_market_cap_usd=30_000,
    min_liquidity_usd=15_000,
    min_volume_24h_usd=20_000,
    min_txns_24h=100,
    min_liq_mcap_ratio=0.03,
    min_pair_age_minutes=15,
    max_pair_age_days=5,
    max_drop_1h_pct=30,
    max_alerts_per_day=10,
    check_interval_seconds=300,
    axiom_referral_link="https://axiom.trade/@x",
    result_celebrate_pct=50,
    result_min_age_hours=6,
    result_max_age_days=7,
)


def test_settings_validas_no_dan_problemas():
    assert validate_settings(Settings(**BASE)) == []


def test_sin_token_falla():
    settings = Settings(**{**BASE, "discord_token": ""})
    problemas = validate_settings(settings)
    assert any("DISCORD_TOKEN" in p for p in problemas)


def test_sin_canal_falla():
    settings = Settings(**{**BASE, "discord_channel_id": 0})
    problemas = validate_settings(settings)
    assert any("DISCORD_CHANNEL_ID" in p for p in problemas)


def test_intervalo_invalido_falla():
    settings = Settings(**{**BASE, "check_interval_seconds": 0})
    problemas = validate_settings(settings)
    assert any("CHECK_INTERVAL_SECONDS" in p for p in problemas)
