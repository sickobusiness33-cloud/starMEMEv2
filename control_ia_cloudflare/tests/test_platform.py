"""Tests de la plataforma de IA: AI Router, fallback, Agent Hub, multiagente, planes y pagos.

Requisitos (además de los de test_api.py):
    .dev.vars con AI_MODE=mock, ADMIN_EMAILS=admin-tests@example.com,
    ANTHROPIC_API_KEY=<cualquiera> y ANTHROPIC_BASE_URL=http://127.0.0.1:8799
    python tests/mock_anthropic.py &      # imita la API de Claude (con y sin créditos)
"""

from __future__ import annotations

import time
import uuid

import httpx
import pytest

from test_api import BASE, PASSWORD, Api, api, register  # noqa: F401 (api es un fixture)

MOCK = "http://127.0.0.1:8799"
ADMIN_EMAIL = "admin-tests@example.com"


def admin() -> Api:
    api = Api()
    r = api.c.post("/api/auth/register", json={"email": ADMIN_EMAIL, "name": "Admin", "password": PASSWORD})
    if r.status_code != 200:
        r = api.c.post("/api/auth/login", json={"email": ADMIN_EMAIL, "password": PASSWORD})
    assert r.status_code == 200, r.text
    api.csrf = r.json()["csrf_token"]
    api.email = ADMIN_EMAIL
    return api


def mock_mode(mode: str) -> dict:
    return httpx.post(f"{MOCK}/__mode", json={"mode": mode}).json()


def mock_calls() -> int:
    return httpx.get(MOCK).json()["calls"]


def make_pro(api: Api) -> None:
    r = admin().post("/api/billing/admin/set-plan", json={"email": api.email, "plan": "pro", "months": 1})
    assert r.status_code == 200, r.text
    assert r.json()["plan"] == "pro"


def claude_retry() -> None:
    assert admin().post("/api/metrics/admin/claude/retry").status_code == 200


def run_agent(api: Api, agent_id: str, text: str):
    return api.post(f"/api/hub/agents/{agent_id}/run", json={"input": text})


def wait_agent(api: Api, run_id: int, timeout: float = 60.0) -> dict:
    deadline = time.monotonic() + timeout
    run = {}
    while time.monotonic() < deadline:
        run = api.get(f"/api/hub/runs/{run_id}").json()
        if run["status"] in ("completed", "failed", "cancelled"):
            return run
        time.sleep(0.3)
    raise AssertionError(f"La ejecución de agente {run_id} no terminó: {run.get('status')}")


@pytest.fixture(autouse=True)
def _claude_ok():
    mock_mode("ok")
    claude_retry()
    yield


# --- Agent Hub: catálogo --------------------------------------------------------


def test_catalogo_categorias_busqueda_y_filtros(api):
    cats = api.get("/api/hub/categories").json()
    assert len(cats) == 18 and all(c["count"] >= 3 for c in cats)
    data = api.get("/api/hub/agents").json()
    assert data["total"] >= 54 and data["plan"] == "free"
    a = data["agents"][0]
    for key in ("id", "name", "description", "category", "tier", "source", "model", "tools", "capabilities", "uses"):
        assert key in a
    assert isinstance(a["uses"], int)  # usos reales, nunca inventados
    trading = api.get("/api/hub/agents?category=trading").json()["agents"]
    assert trading and all(x["category"] == "trading" for x in trading)
    pro = api.get("/api/hub/agents?tier=pro").json()["agents"]
    assert pro and all(x["tier"] == "pro" for x in pro)
    assert any(x["id"] == "seo-auditor" for x in api.get("/api/hub/agents?q=seo").json()["agents"])
    free_model = api.get("/api/hub/agents?compat=free-model").json()["agents"]
    assert all(x["model"]["free_model_compatible"] for x in free_model)
    names = [x["name"] for x in api.get("/api/hub/agents?sort=name").json()["agents"]]
    assert names == sorted(names, key=str.lower) or names == sorted(names)


def test_detalle_agente_con_origen_licencia_y_permisos(api):
    a = api.get("/api/hub/agents/deep-research").json()
    assert a["tier"] == "pro" and a["model"]["prefer"] == "premium" and a["model"]["fallback"] is True
    assert a["source"]["license"] in ("MIT", "Apache-2.0")
    assert a["source"]["url"].startswith("https://github.com/")
    assert "no incluye código" in a["source"]["attribution"]
    assert a["tools"] and a["tools"][0]["permission"]
    assert a["stages"][0]["label"] == "Planning" and a["instructions"]
    assert api.get("/api/hub/agents/no-existe").status_code == 404


# --- Ejecución de agentes -----------------------------------------------------------


def test_agente_gratuito_por_etapas_con_modelo_gratis(api):
    r = run_agent(api, "research-agent", "Historia de la computación cuántica")
    assert r.status_code == 201, r.text
    assert [s["status"] for s in r.json()["stages"]] == ["pending"] * len(r.json()["stages"])
    run = wait_agent(api, r.json()["id"])
    assert run["status"] == "completed", run
    assert [s["id"] for s in run["stages"]] == ["planning", "researching", "analyzing", "generating"]
    assert all(s["status"] == "completed" for s in run["stages"])
    assert run["stages"][0]["provider"] == "workers-ai"
    assert "[modelo de prueba @cf/meta/llama-3.3-70b-instruct-fp8-fast]" in run["output"]
    assert run["notices"] == []
    assert "Wikipedia, CC BY-SA" in run["stages"][1]["preview"]


def test_agentes_premium_y_multiagente_requieren_pro(api):
    r = run_agent(api, "deep-research", "tema")
    assert r.status_code == 402 and "Pro" in r.json()["error"]
    r = run_agent(api, "investment-committee", "idea")
    assert r.status_code == 402


def test_premium_con_pro_usa_claude(api):
    make_pro(api)
    run = wait_agent(api, run_agent(api, "deep-research", "Energía de fusión").json()["id"])
    assert run["status"] == "completed", run
    llm = [s for s in run["stages"] if s["kind"] == "llm"]
    assert all(s["provider"] == "claude" and s["model"] == "claude-opus-5" for s in llm)
    assert run["output"].startswith("[claude mock claude-opus-5]")


def test_premium_sin_creditos_usa_respaldo_y_vuelve_solo(api):
    make_pro(api)
    mock_mode("credit")
    run = wait_agent(api, run_agent(api, "advanced-coding", "Diseña una API de tareas").json()["id"])
    assert run["status"] == "completed", run
    assert any("sin créditos" in n for n in run["notices"])
    assert all(s["provider"] == "workers-ai" for s in run["stages"] if s["kind"] == "llm")
    status = api.get("/api/ai/status").json()
    assert status["claude"]["platform_available"] is False and status["claude"]["retry_after"]
    # Mientras dura el enfriamiento no se vuelve a llamar a Claude.
    before = mock_calls()
    t = api.post("/api/chat/threads", json={"mode": "router"}).json()
    m = api.post(f"/api/chat/threads/{t['id']}/messages", json={"content": "hola"}).json()["message"]
    assert m["provider"] == "workers-ai" and m["fallback"] == 1 and "Modelo premium no disponible" in m["notice"]
    assert mock_calls() == before
    # Se recargan créditos: sin tocar código, Claude vuelve a responder.
    mock_mode("ok")
    claude_retry()
    m = api.post(f"/api/chat/threads/{t['id']}/messages", json={"content": "¿sigues ahí?"}).json()["message"]
    assert m["provider"] == "claude" and m["fallback"] == 0 and m["notice"] is None


def test_multiagente_maestro_subagentes_y_final(api):
    make_pro(api)
    run = wait_agent(api, run_agent(api, "investment-committee", "Acciones de una eléctrica europea").json()["id"], timeout=90)
    assert run["status"] == "completed", run
    team = next(s for s in run["stages"] if s["kind"] == "agents")
    assert [a["id"] for a in team["agents"]] == ["data-analyst", "research-agent", "risk-reviewer"]
    assert all(a["status"] == "completed" for a in team["agents"])
    assert run["stages"][-1]["status"] == "completed"
    assert "no es asesoramiento financiero" in run["output"].lower() or run["output"]


def test_agente_de_imagen(api):
    run = wait_agent(api, run_agent(api, "logo-concepts", "Cafetería Luna, minimalista").json()["id"])
    assert run["status"] == "completed", run
    assert run["output_kind"] == "image" and run["output"].startswith("/9j/")
    listed = api.get("/api/hub/runs").json()[0]
    assert listed["output"] == ""  # el listado no transporta imágenes


def test_lector_web_solo_urls_publicas(api):
    run = wait_agent(api, run_agent(api, "page-reader", "Resume http://127.0.0.1:8787/api/healthz").json()["id"])
    assert run["status"] == "completed"
    assert "solo se permiten páginas públicas" in run["stages"][0]["preview"]


def test_cancelar_ejecucion_de_agente(api):
    r = run_agent(api, "business-plan", "Tienda de bicis").json()
    c = api.post(f"/api/hub/runs/{r['id']}/cancel")
    assert c.status_code in (200, 409)
    run = wait_agent(api, r["id"])
    assert run["status"] in ("cancelled", "completed")
    other = register()
    assert other.get(f"/api/hub/runs/{r['id']}").status_code == 404


# --- Chat central -------------------------------------------------------------------


def test_chat_modos_y_limites(api):
    t = api.post("/api/chat/threads", json={"mode": "free"}).json()
    r = api.post(f"/api/chat/threads/{t['id']}/messages", json={"content": "Hola, ¿qué tal?"})
    assert r.status_code == 201
    m = r.json()["message"]
    assert m["provider"] == "workers-ai" and m["model"].startswith("@cf/")
    # Modo "solo Claude" sin Pro ni clave propia: error claro, sin respaldo silencioso.
    api.patch(f"/api/chat/threads/{t['id']}", json={"mode": "claude"})
    r = api.post(f"/api/chat/threads/{t['id']}/messages", json={"content": "hola"})
    assert r.status_code == 409 and "premium no disponible" in r.json()["error"].lower()
    # Límite de contexto del plan Free.
    r = api.post(f"/api/chat/threads/{t['id']}/messages", json={"content": "x" * 4001, "mode": "free"})
    assert r.status_code == 413
    # Si fallan los dos modelos gratuitos: error claro, sin inventar respuesta.
    r = api.post(f"/api/chat/threads/{t['id']}/messages", json={"content": "[forzar-error-gratis]", "mode": "free"})
    assert r.status_code == 502 and "Ningún modelo" in r.json()["error"]
    thread = api.get(f"/api/chat/threads/{t['id']}").json()
    assert thread["title"] == "Hola, ¿qué tal?"
    assert register().get(f"/api/chat/threads/{t['id']}").status_code == 404


def test_chat_con_agente_y_premium_bloqueado(api):
    t = api.post("/api/chat/threads", json={"mode": "agent:translator"}).json()
    m = api.post(f"/api/chat/threads/{t['id']}/messages", json={"content": "Traduce: hello"}).json()["message"]
    assert m["agent_id"] == "translator"
    r = api.post(f"/api/chat/threads/{t['id']}/messages", json={"content": "x", "mode": "agent:complex-reasoning"})
    assert r.status_code == 402


def test_limite_de_entrada_de_agentes_free(api):
    r = run_agent(api, "editor", "x" * 4001)
    assert r.status_code == 413 and ("4000" in r.json()["error"] or "4.000" in r.json()["error"])


# --- Planes y pagos -------------------------------------------------------------------


def test_planes_precio_centralizado_y_pagos_desactivados(api):
    b = api.get("/api/billing/plans").json()
    assert b["price"] == {"amount": 20, "currency": "EUR", "interval": "month"}
    assert b["payments_enabled"] is False and b["payment_provider"] == "none"
    assert b["subscription"]["plan"] == "free"
    assert any(f["status"] == "coming_soon" for f in b["plans"]["pro"]["features"])
    assert b["plans"]["free"]["limits"]["premiumAgents"] is False
    r = api.post("/api/billing/checkout")
    assert r.status_code == 503 and "no están activados" in r.json()["error"]
    assert httpx.post(f"{BASE}/api/billing/webhook/stripe", content=b"{}").status_code == 404
    assert api.post("/api/billing/admin/set-plan", json={"email": api.email, "plan": "pro"}).status_code == 403


def test_upgrade_es_una_ruta_de_la_web():
    r = httpx.get(f"{BASE}/upgrade")
    assert r.status_code == 200 and "Control IA" in r.text


# --- Métricas y seguridad del registro ----------------------------------------------------


def test_metricas_reales_solo_admin(api):
    wait_agent(api, run_agent(api, "swot", "Una panadería de barrio").json()["id"])
    assert api.get("/api/metrics/admin").status_code == 403
    me = api.get("/api/metrics/me").json()
    assert me["usage_today"]["agents"] >= 1 and me["by_provider"][0]["calls"] >= 1
    m = admin().get("/api/metrics/admin?days=1").json()
    assert m["totals"]["calls"] >= 1
    assert any(x["agent_id"] == "swot" for x in m["by_agent"])
    assert {"provider", "model", "calls", "ok", "fallbacks", "avg_latency_ms", "cost_usd"} <= set(m["by_provider"][0])


GOOD = {
    "id": "",
    "name": "Haiku Writer",
    "description": "Escribe haikus sobre cualquier tema.",
    "category": "writing",
    "version": "1.0.0",
    "tier": "free",
    "color": "verde",
    "model": {"prefer": "free", "allowFallback": True},
    "input": {"label": "Tema", "placeholder": "El mar"},
    "instructions": "Eres poeta. Escribe haikus 5-7-5.",
    "stages": [{"id": "generating", "label": "Generating", "kind": "llm", "prompt": "Haiku sobre: {{input}}"}],
    "tools": [],
    "capabilities": ["Haikus"],
    "source": {"type": "original", "label": "Control IA", "license": "Original (Control IA)"},
    "added": "2026-09-28",
}


def test_pipeline_de_validacion_de_manifiestos(api):
    adm = admin()
    assert api.post("/api/hub/submissions", json={"manifest": GOOD}).status_code == 403
    bad = {**GOOD, "id": "malo-" + uuid.uuid4().hex[:6], "tools": ["shell"], "code": "rm -rf /",
           "source": {"type": "external", "label": "x", "license": "GPL-3.0"}}
    r = adm.post("/api/hub/submissions", json={"manifest": bad})
    assert r.status_code == 422
    checks = {c["step"]: c["ok"] for c in r.json()["checks"]}
    assert checks["license"] is False and checks["security"] is False
    good = {**GOOD, "id": "haiku-" + uuid.uuid4().hex[:6]}
    r = adm.post("/api/hub/submissions", json={"manifest": good})
    assert r.status_code == 201 and r.json()["status"] == "validated"
    assert api.get(f"/api/hub/agents/{good['id']}").status_code == 404  # validado ≠ disponible
    assert adm.post(f"/api/hub/submissions/{good['id']}/publish").status_code == 200
    assert api.get(f"/api/hub/agents/{good['id']}").json()["origin"] == "hub"
    run = wait_agent(api, run_agent(api, good["id"], "otoño").json()["id"])
    assert run["status"] == "completed"
    assert adm.post(f"/api/hub/submissions/{good['id']}/disable").status_code == 200
    assert api.get(f"/api/hub/agents/{good['id']}").status_code == 404
    dup = adm.post("/api/hub/submissions", json={"manifest": {**GOOD, "id": "translator"}})
    assert dup.status_code == 409


def test_fuentes_y_licencias(api):
    d = api.get("/api/hub/sources").json()
    assert sum(d["counts"].values()) >= 5000
    excluded = {f["name"] for f in d["frameworks"] if f["integration"] == "excluded"}
    assert "AutoGPT" in excluded and "n8n" in excluded
    assert all(f["license"] in ("MIT", "Apache-2.0", "MIT (código) · CC-BY-4.0 (docs)") or f["integration"] != "method" for f in d["frameworks"])
    assert any(m["attribution"] == "Built with Llama" for m in d["models"])
    assert api.post("/api/hub/sources/check", json={"limit": 5}).status_code == 403
