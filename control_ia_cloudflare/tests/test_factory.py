"""Autonomous Project Factory (AI_MODE=mock): orden → ideas → investigación → construcción →
QA → seguridad → despliegue → verificación, web pública con CSP sandbox, herramienta de IA,
rechazo de ideas malas y aislamiento entre usuarios."""

from __future__ import annotations

import time

import httpx

from test_api import BASE, Api, api, register  # noqa: F401
from test_platform import mock_mode


def wait_live(api: Api, n: int, timeout: float = 90) -> list[dict]:
    deadline = time.monotonic() + timeout
    ps: list[dict] = []
    while time.monotonic() < deadline:
        ps = api.get("/api/factory").json()["projects"]
        done = [p for p in ps if p["stage"] == "live" or p["status"] in ("failed", "rejected")]
        if len(ps) >= n and len(done) == len(ps):
            return ps
        time.sleep(0.5)
    raise AssertionError([(p["name"], p["stage"], p["status"], p.get("errors")) for p in ps])


def test_orden_crea_proyectos_reales_y_los_publica(api):
    mock_mode("ok")
    r = api.post("/api/factory/command", json={"text": "Hazme 2 webs de meme coins al día"})
    assert r.status_code == 200, r.text
    m = r.json()["mission"]
    assert m["kind"] == "website" and m["niche"] == "crypto" and m["perDay"] == 2 and m["created"] == 2
    ps = wait_live(api, 2)
    live = [p for p in ps if p["stage"] == "live"]
    assert len(live) >= 2, [(p["name"], p["status"], p["errors"]) for p in ps]
    p = live[0]
    assert p["url"].endswith(f"/s/{p['slug']}/") and "DexScreener API" in p["apis"]

    d = api.get(f"/api/factory/projects/{p['id']}").json()
    assert all(c["ok"] for c in d["checks"]["qa"] if c["required"])
    assert all(c["ok"] for c in d["checks"]["security"])
    stages = {e["stage"] for e in d["events"]}
    assert {"research", "building", "testing", "security", "deploying", "live"} <= stages

    # La web publicada: HTML real, aislada con CSP sandbox, sin scripts inline.
    w = httpx.get(f"{BASE}/s/{p['slug']}/")
    assert w.status_code == 200 and "<h1>" in w.text and 'data-widget="crypto-trending"' in w.text
    csp = w.headers["content-security-policy"]
    assert csp.startswith("sandbox allow-scripts") and "script-src 'self'" in csp
    assert w.headers["x-content-type-options"] == "nosniff"
    assert httpx.get(f"{BASE}/s/{p['slug']}").status_code in (301, 308)
    # Recursos compartidos y escaparate/sitemap
    assert httpx.get(f"{BASE}/fx-runtime.js").status_code == 200
    assert httpx.get(f"{BASE}/fx-site.css").status_code == 200
    assert p["slug"] in httpx.get(f"{BASE}/s/").text
    assert p["slug"] in httpx.get(f"{BASE}/s/sitemap.xml").text

    # Herramienta de IA de la web (pública, con límites) y datos con CORS
    ai = httpx.post(f"{BASE}/fx/ai/{p['slug']}", json={"input": "Explícame qué es la liquidez"})
    assert ai.status_code == 200 and ai.json()["text"], ai.text
    assert ai.headers["access-control-allow-origin"] == "*"
    assert httpx.post(f"{BASE}/fx/ai/{p['slug']}", json={"input": ""}).status_code == 400
    data = httpx.get(f"{BASE}/fx/data/crypto/trending")
    assert data.status_code == 200 and "source" in data.json()
    assert httpx.get(f"{BASE}/fx/data/crypto/token?chain=x&address=<script>").status_code == 400
    assert httpx.get(f"{BASE}/s/no-existe/").status_code == 404

    # Panel: agentes, contadores, eventos
    f = api.get("/api/factory").json()
    assert len(f["agents"]) >= 15 and f["totals"]["live"] >= 2 and f["events"]


def test_idea_mala_se_descarta_y_aislamiento(api):
    mock_mode("ok")
    r = api.post("/api/factory/command", json={"text": "[mock-rechazo] webs de meme coins, 1 al día"})
    assert r.status_code == 200
    ps = wait_live(api, 1)
    assert any(p["status"] == "rejected" for p in ps)
    other = register()
    assert other.get("/api/factory").json()["projects"] == []
    pid = ps[0]["id"]
    assert other.get(f"/api/factory/projects/{pid}").status_code == 404
    assert other.post(f"/api/factory/projects/{pid}/delete").status_code == 404
    assert api.post(f"/api/factory/projects/{pid}/delete").status_code == 200


def test_ajustes_y_pausa(api):
    r = api.put("/api/factory/settings", json={"daily_target": 34, "max_parallel": 4, "niches": [{"id": "crypto", "weight": 9, "enabled": True}, {"id": "ai", "weight": 7, "enabled": True}]})
    assert r.status_code == 200
    s = api.get("/api/factory").json()["settings"]
    assert s["daily_target"] == 34 and s["max_parallel"] == 4 and s["niches"][0]["weight"] == 9
    assert api.post("/api/factory/pause").status_code == 200
    assert api.get("/api/factory").json()["settings"]["enabled"] is False


def test_mision_meme_coins_con_logo_y_parar(api):
    mock_mode("ok")
    r = api.post("/api/factory/command", json={"text": "Créame una criptomoneda", "per_day": 2})
    assert r.status_code == 200, r.text
    m = r.json()["mission"]
    assert m["kind"] == "memecoin" and m["perDay"] == 2 and m["created"] == 2
    ps = wait_live(api, 2)
    live = [p for p in ps if p["stage"] == "live"]
    assert len(live) == 2, [(p["name"], p["status"], p["errors"]) for p in ps]
    p = live[0]
    assert p["kind"] == "memecoin" and p["ticker"] and p["mission_id"] == m["id"]
    d = api.get(f"/api/factory/projects/{p['id']}").json()
    assert all(c["ok"] for c in d["checks"]["qa"] if c["required"]), d["checks"]["qa"]
    assert {"coin.logo", "coin.identity", "coin.honest"} <= {c["id"] for c in d["checks"]["qa"]}
    assert all(c["ok"] for c in d["checks"]["security"])
    # Web de la moneda: logo propio, lore, tokenomics y aviso de que no está on-chain
    w = httpx.get(f"{BASE}/s/{p['slug']}/")
    assert w.status_code == 200 and 'fx-coin-logo' in w.text and 'id="tokenomics"' in w.text
    assert "no existe en ninguna blockchain" in w.text and f"${p['ticker']}" in w.text
    logo = httpx.get(f"{BASE}/s/{p['slug']}/logo")
    assert logo.status_code == 200 and logo.headers["content-type"].startswith("image/") and len(logo.content) > 50
    assert httpx.get(f"{BASE}/s/no-existe/logo").status_code == 404
    for n in ("art", "meme"):
        assert httpx.get(f"{BASE}/s/{p['slug']}/{n}").status_code == 200
    assert 'class="cx-donut"' in w.text and 'id="roadmap"' in w.text and "cx-marquee" in w.text

    # Coin Studio: apartado propio, cualquier temática forzada a meme coin
    cs = api.get("/api/factory/coins").json()
    assert cs["totals"]["live"] == 2 and {"logo", "art", "meme"} <= set(cs["coins"][0]["images"])
    assert cs["missions"][0]["id"] == m["id"] and cs["free_quota"] is True
    r2 = api.post("/api/factory/command", json={"text": "webs de dinosaurios DJ", "kind": "memecoin", "per_day": 1})
    assert r2.json()["mission"]["kind"] == "memecoin"
    wait_live(api, 3)

    # Panel: la misión muestra su progreso del día
    f = api.get("/api/factory").json()
    mm = next(x for x in f["missions"] if x["id"] == m["id"])
    assert mm["active"] == 1 and mm["made_today"] == 2 and mm["live_total"] == 2
    # Parar / reanudar / cambiar cupo / aislamiento
    other = register()
    assert other.patch(f"/api/factory/missions/{m['id']}", json={"active": False}).status_code == 404
    assert api.patch(f"/api/factory/missions/{m['id']}", json={"active": False, "per_day": 7}).status_code == 200
    mm = next(x for x in api.get("/api/factory").json()["missions"] if x["id"] == m["id"])
    assert mm["active"] == 0 and mm["per_day"] == 7
    assert api.delete(f"/api/factory/missions/{m['id']}").status_code == 200
    assert all(x["id"] != m["id"] for x in api.get("/api/factory").json()["missions"])
    # Lo creado se conserva
    assert httpx.get(f"{BASE}/s/{p['slug']}/").status_code == 200


def test_respuesta_cortada_se_repara_y_el_cupo_respeta_el_numero(api):
    """Fallo real de producción: la IA devolvía el JSON cortado (límite de tokens) y todas las monedas fallaban."""
    mock_mode("ok")
    r = api.post("/api/factory/command", json={"text": "[mock-cortado] haz 2 cryptos de gatos", "kind": "memecoin", "per_day": 10})
    m = r.json()["mission"]
    assert m["perDay"] == 2, m  # el número escrito manda sobre el control deslizante
    ps = wait_live(api, 2)
    assert [p["stage"] for p in ps] == ["live", "live"], [(p["name"], p["status"], p["errors"]) for p in ps]
    d = api.get(f"/api/factory/projects/{ps[0]['id']}").json()
    assert d["spec"]["coin"]["lore"] and all(c["ok"] for c in d["checks"]["qa"] if c["required"])
    # Con el cupo diario cumplido no se crean más (aunque fallaran)
    cs = api.get("/api/factory/coins").json()
    assert cs["missions"][0]["made_today"] == 2 and cs["totals"]["coins"] == 2


MOCK_URL = "http://127.0.0.1:8799"


def test_gemini_y_groq_respaldo_y_cambio_de_ia(api):
    """Gemini y Groq (claves gratuitas) entran solas como respaldo; si una se queda sin cupo se pasa a la otra;
    y se puede fijar/cambiar la IA de una producción o de un proyecto."""
    mock_mode("ok")
    for vid, key in (("gemini", "AIzaTestKey123456"), ("groq", "gsk_TestKey123456")):
        r = api.put(f"/api/providers/{vid}/key", json={"api_key": key})
        assert r.status_code == 200, r.text
        assert api.post(f"/api/providers/{vid}/test").json()["ok"] is True
    names = {p["id"]: p["name"] for p in api.get("/api/providers").json()}
    assert names["gemini"] == "Google Gemini" and names["groq"] == "Groq"

    # 1) Automático: Gemini responde primero (antes que el cupo de Cloudflare)
    m = api.post("/api/factory/command", json={"text": "haz 1 crypto de nubes", "kind": "memecoin"}).json()["mission"]
    ps = wait_live(api, 1)
    assert ps[0]["stage"] == "live", ps
    ext = httpx.get(MOCK_URL).json()["ext"]
    assert any(e["vendor"] == "gemini" and e["model"] == "gemini-3.8-flash" and e["auth"].startswith("Bearer AIza") for e in ext), ext
    cs = api.get("/api/factory/coins").json()
    assert cs["coins"][0]["last_ai"].startswith("gemini-byok")
    assert {a["id"]: a["available"] for a in cs["ais"]}["gemini"] is True

    # 2) Gemini sin cupo → sigue solo con Groq, y Gemini queda apartado (sin cupo)
    httpx.post(f"{MOCK_URL}/__mode", json={"mode": "ext-quota"})
    api.post("/api/factory/command", json={"text": "haz 1 crypto de lluvia", "kind": "memecoin"})
    ps = wait_live(api, 2)
    assert all(p["stage"] == "live" for p in ps), ps
    ext = httpx.get(MOCK_URL).json()["ext"]
    assert any(e["vendor"] == "groq" for e in ext), ext
    cs = api.get("/api/factory/coins").json()
    assert {a["id"]: a["available"] for a in cs["ais"]}["gemini"] is False
    assert any(c["last_ai"].startswith("groq-byok") for c in cs["coins"])

    # 3) Fijar la IA: la producción y el proyecto pasan a Cloudflare
    mock_mode("ok")
    assert api.patch(f"/api/factory/missions/{m['id']}", json={"ai_pref": "cloudflare"}).status_code == 200
    assert next(x for x in api.get("/api/factory/coins").json()["missions"] if x["id"] == m["id"])["ai_pref"] == "cloudflare"
    pid = ps[0]["id"]
    r = api.post(f"/api/factory/projects/{pid}/ai", json={"ai_pref": "groq"})
    assert r.status_code == 200 and r.json()["ai_pref"] == "groq"
    assert api.post(f"/api/factory/projects/{pid}/ai", json={"ai_pref": "nada-raro"}).json()["ai_pref"] is None
    r = api.post("/api/factory/command", json={"text": "haz 1 crypto de volcanes", "kind": "memecoin", "ai_pref": "cloudflare"}).json()["mission"]
    ps = wait_live(api, 3)
    newest = max(ps, key=lambda p: p["id"])
    assert newest["stage"] == "live"
    cs = api.get("/api/factory/coins").json()
    assert next(c for c in cs["coins"] if c["id"] == newest["id"])["last_ai"].startswith("workers-ai")
