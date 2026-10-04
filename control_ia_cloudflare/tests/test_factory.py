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
    r = api.post("/api/factory/command", json={"text": "Crea proyectos nuevos de meme coins"})
    assert r.status_code == 200, r.text
    assert r.json()["niche"] == "crypto" and r.json()["created"] >= 2
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
    r = api.post("/api/factory/command", json={"text": "[mock-rechazo] meme coins", "niche": "crypto", "count": 1})
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
