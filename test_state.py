from state import StateStore


def test_estado_nuevo_esta_vacio(tmp_path):
    store = StateStore(str(tmp_path / "state.json"))
    assert store.seen == set()
    assert store.count_today == 0
    assert store.historial == []


def test_mark_alert_sent_guarda_y_persiste(tmp_path):
    path = str(tmp_path / "state.json")
    store = StateStore(path)
    store.mark_alert_sent({"mint": "abc", "symbol": "FOO", "_market_cap": 1000})

    assert "abc" in store.seen
    assert store.count_today == 1
    assert store.historial[-1]["symbol"] == "FOO"

    # Un StateStore nuevo apuntando al mismo archivo debe ver los mismos datos.
    reloaded = StateStore(path)
    assert "abc" in reloaded.seen
    assert reloaded.count_today == 1


def test_can_alert_today_respeta_el_tope(tmp_path):
    store = StateStore(str(tmp_path / "state.json"))
    for i in range(3):
        store.mark_alert_sent({"mint": f"mint-{i}", "symbol": "FOO", "_market_cap": 1000})

    assert store.can_alert_today(max_per_day=3) is False
    assert store.can_alert_today(max_per_day=5) is True


def test_archivo_corrupto_no_rompe_la_carga(tmp_path):
    path = tmp_path / "state.json"
    path.write_text("esto no es json valido {{{")

    store = StateStore(str(path))
    assert store.seen == set()
    assert store.count_today == 0
