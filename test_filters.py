from config import Settings
from filters import find_qualifying_token

SETTINGS = Settings(
    discord_token="x",
    discord_channel_id=1,
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

NOW_MS = 10_000_000_000  # referencia arbitraria fija para los tests


def make_candidate(**overrides):
    base = {
        "mint": "mint-1",
        "market_cap": 100_000,
        "liquidity": 20_000,
        "volume_24h": 30_000,
        "txns_24h": 150,
        "pair_created_at": NOW_MS - 60 * 60_000,  # hace 1 hora
        "price_change_h1": 5,
    }
    base.update(overrides)
    return base


def test_candidato_valido_es_seleccionado():
    token, stats = find_qualifying_token([make_candidate()], seen=set(), settings=SETTINGS, now_ms=NOW_MS)
    assert token is not None
    assert token["mint"] == "mint-1"
    assert stats["cumplen"] == 1


def test_candidato_ya_visto_se_ignora():
    token, stats = find_qualifying_token(
        [make_candidate()], seen={"mint-1"}, settings=SETTINGS, now_ms=NOW_MS
    )
    assert token is None
    assert stats["nuevos"] == 0


def test_liquidez_insuficiente_descarta():
    token, _ = find_qualifying_token(
        [make_candidate(liquidity=1_000)], seen=set(), settings=SETTINGS, now_ms=NOW_MS
    )
    assert token is None


def test_par_demasiado_joven_descarta():
    token, _ = find_qualifying_token(
        [make_candidate(pair_created_at=NOW_MS - 60_000)],  # hace 1 minuto
        seen=set(),
        settings=SETTINGS,
        now_ms=NOW_MS,
    )
    assert token is None


def test_par_demasiado_viejo_descarta():
    diez_dias_ms = 10 * 24 * 60 * 60_000
    token, _ = find_qualifying_token(
        [make_candidate(pair_created_at=NOW_MS - diez_dias_ms)],
        seen=set(),
        settings=SETTINGS,
        now_ms=NOW_MS,
    )
    assert token is None


def test_caida_fuerte_en_1h_descarta():
    token, _ = find_qualifying_token(
        [make_candidate(price_change_h1=-40)], seen=set(), settings=SETTINGS, now_ms=NOW_MS
    )
    assert token is None


def test_elige_el_de_mas_transacciones():
    candidatos = [
        make_candidate(mint="mint-bajo", txns_24h=110),
        make_candidate(mint="mint-alto", txns_24h=500),
    ]
    token, _ = find_qualifying_token(candidatos, seen=set(), settings=SETTINGS, now_ms=NOW_MS)
    assert token["mint"] == "mint-alto"


def test_sin_candidatos_no_falla():
    token, stats = find_qualifying_token([], seen=set(), settings=SETTINGS, now_ms=NOW_MS)
    assert token is None
    assert stats["total"] == 0
