"""Tests de sources.py sin red real: se parchea _session.get."""

from unittest.mock import MagicMock, patch

import requests

import sources


def _response(json_data):
    resp = MagicMock()
    resp.json.return_value = json_data
    resp.raise_for_status.return_value = None
    return resp


def test_get_reintenta_y_luego_funciona():
    """Si las 2 primeras llamadas fallan pero la 3ª responde, debe devolver esa."""
    calls = {"n": 0}

    def fake_get(*args, **kwargs):
        calls["n"] += 1
        if calls["n"] < 3:
            raise requests.ConnectionError("boom")
        return _response({"ok": True})

    with patch.object(sources._session, "get", side_effect=fake_get), patch("time.sleep"):
        result = sources._get("https://example.com")

    assert result == {"ok": True}
    assert calls["n"] == 3


def test_get_devuelve_none_si_todos_los_intentos_fallan():
    with (
        patch.object(sources._session, "get", side_effect=requests.ConnectionError("boom")),
        patch("time.sleep"),
    ):
        result = sources._get("https://example.com")
    assert result is None


def test_get_all_candidates_deduplica_por_mint_quedandose_con_mas_liquidez():
    candidato_bajo = {"mint": "abc", "liquidity": 10, "source": "a"}
    candidato_alto = {"mint": "abc", "liquidity": 999, "source": "b"}

    with (
        patch("sources.from_pumpfun", return_value=[candidato_bajo]),
        patch("sources.from_dexscreener_boosts", return_value=[candidato_alto]),
        patch("sources.from_dexscreener_search", return_value=[]),
    ):
        result = sources.get_all_candidates()

    assert len(result) == 1
    assert result[0]["source"] == "b"
