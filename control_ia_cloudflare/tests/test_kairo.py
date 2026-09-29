"""Tests de Kairo: orquestador multiagente, Activity Panel (SSE), modo manual,
Model Router con fallback, API propia, estudio de imágenes y notificaciones.

Mismos requisitos que test_platform.py (AI_MODE=mock + mock de Claude).
"""

from __future__ import annotations

import base64
import json
import time

import httpx
import pytest

from test_api import BASE, PASSWORD, Api, api, register  # noqa: F401 (api es un fixture)
from test_platform import make_pro, mock_mode

TERMINAL = ("completed", "failed", "cancelled")
PNG_1PX = "data:image/png;base64," + base64.b64encode(
    bytes.fromhex("89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6360000002000154a24f5d0000000049454e44ae426082")
).decode()


@pytest.fixture(autouse=True)
def _mock_ok():
    mock_mode("ok")
    yield


def new_chat(api: Api) -> dict:
    r = api.post("/api/chat/threads", json={})
    assert r.status_code == 201, r.text
    return r.json()


def ask(api: Api, tid: int, text: str, **extra) -> dict:
    r = api.post(f"/api/chat/threads/{tid}/messages", json={"content": text, **extra})
    assert r.status_code == 202, r.text
    return r.json()["run"]


def wait_run(api: Api, rid: int, timeout: float = 90) -> dict:
    deadline = time.monotonic() + timeout
    st = {}
    while time.monotonic() < deadline:
        st = api.get(f"/api/chat/runs/{rid}").json()
        if st["run"]["status"] in TERMINAL:
            return st
        time.sleep(0.3)
    raise AssertionError(f"La ejecución {rid} no terminó: {st.get('run', {}).get('status')}")


# --- Nuevo chat y registro de agentes -------------------------------------------------------


def test_nuevo_chat_modo_auto_y_todos_los_agentes_disponibles(api):
    t = new_chat(api)
    assert t["mode"] == "auto" and t["auto_mode"] is True
    reg = api.get("/api/chat/agents").json()
    assert reg["brand"]["name"] == "Kairo"
    assert len(reg["agents"]) >= 55
    assert all(a["category"] != "multi" for a in reg["agents"])  # el orquestador ya es multiagente
    assert any(a["locked"] for a in reg["agents"]) and reg["max_agents_per_message"] == 3
    assert {"vision-analyst", "image-editor", "image-variations", "social-post-creator", "math-solver"} <= {a["id"] for a in reg["agents"]}
    assert reg["models"] and reg["tools"]


def test_respuesta_directa_sin_agentes(api):
    t = new_chat(api)
    st = wait_run(api, ask(api, t["id"], "hola")["id"])
    assert st["run"]["status"] == "completed" and st["run"]["direct"] is True
    assert st["agents"] == []
    assert st["message"]["content"].startswith("[modelo de prueba")


def test_orquestador_elige_agentes_con_dependencias_y_combina(api):
    t = new_chat(api)
    st = wait_run(api, ask(api, t["id"], "Investiga la historia del café y crea un post para Instagram con imagen")["id"])
    assert st["run"]["status"] == "completed", st["run"]
    ids = [a["agent_id"] for a in st["agents"]]
    # Dos especialistas + el revisor (validación) que se activa cuando colaboran varios agentes.
    assert ids == ["research-agent", "social-post-creator", "kairo-reviewer"]
    research, social, review = st["agents"]
    assert review["depends_on"] == [research["step"], social["step"]] and review["status"] == "COMPLETED"
    assert social["depends_on"] == [research["step"]] and research["depends_on"] == []
    assert all(a["status"] == "COMPLETED" and a["progress"] == 100 for a in st["agents"])
    for a in (research, social):
        assert a["model"] and a["execution_ms"] is not None and 0 < a["confidence"] <= 1
        assert a["metadata"]["confidence_method"] == "heuristic"
    # El agregador recibe resultados estructurados y da UNA respuesta con la imagen adjunta.
    msg = st["message"]
    assert "Resultados estructurados" in msg["content"] and msg["run_id"] == st["run"]["id"]
    assert len(msg["images"]) == 1 and msg["images"][0]["agent"] == "social-post-creator"
    assert api.get(f"/api/images/{msg['images'][0]['id']}/file").headers["content-type"].startswith("image/")
    # Contexto filtrado: el agente social recibió el resultado del investigador.
    assert "Research Agent" in social["result"] or "Resultados de los agentes" in social["result"]


def test_ejecucion_en_paralelo(api):
    t = new_chat(api)
    st = wait_run(api, ask(api, t["id"], "[lento] Investiga el origen del ajedrez y verifica si es cierto que lo inventó un sabio indio")["id"], timeout=120)
    assert st["run"]["status"] == "completed"
    a, b = [x for x in st["agents"] if x["step"] != "review"]
    assert a["depends_on"] == [] and b["depends_on"] == []
    # Se solapan en el tiempo (paralelo), no uno detrás de otro.
    assert a["started_at"] <= b["finished_at"] and b["started_at"] <= a["finished_at"]


def test_stream_sse_en_tiempo_real(api):
    t = new_chat(api)
    run = ask(api, t["id"], "[lento] Resume en 3 puntos qué es la fotosíntesis")
    events = []
    with api.c.stream("GET", f"/api/chat/runs/{run['id']}/stream", timeout=60) as r:
        assert r.headers["content-type"].startswith("text/event-stream")
        event = None
        for line in r.iter_lines():
            if line.startswith("event:"):
                event = line.split(":", 1)[1].strip()
            elif line.startswith("data:") and event == "state":
                events.append(json.loads(line[5:]))
            elif line.startswith("data:") and event == "done":
                break
    statuses = [e["run"]["status"] for e in events]
    assert len(events) >= 3 and statuses[-1] == "completed"
    agent_states = {a["status"] for e in events for a in e["agents"]}
    assert "COMPLETED" in agent_states and agent_states & {"QUEUED", "EXECUTING", "GENERATING", "SEARCHING", "THINKING"}
    assert [e["run"]["version"] for e in events] == sorted({e["run"]["version"] for e in events})


def test_modo_manual(api):
    t = new_chat(api)
    r = api.patch(f"/api/chat/threads/{t['id']}", json={"auto_mode": False, "manual": {"agents": ["translator"], "model": "@cf/qwen/qwen2.5-coder-32b-instruct", "tools_off": ["web_read"]}})
    assert r.status_code == 200 and r.json()["auto_mode"] is False
    st = wait_run(api, ask(api, t["id"], "Traduce al inglés: buenos días")["id"])
    assert st["run"]["mode"] == "manual" and st["run"]["planner"] == "manual"
    assert [a["agent_id"] for a in st["agents"]] == ["translator"]
    assert st["agents"][0]["model"] == "@cf/qwen/qwen2.5-coder-32b-instruct"
    assert api.patch(f"/api/chat/threads/{t['id']}", json={"manual": {"agents": ["deep-research"]}}).status_code == 402
    assert api.patch(f"/api/chat/threads/{t['id']}", json={"manual": {"agents": ["translator", "editor", "summarizer", "swot"]}}).status_code == 422
    assert api.patch(f"/api/chat/threads/{t['id']}", json={"manual": {"model": "no-existe"}}).status_code == 422


def test_fallback_de_modelo_dentro_del_orquestador(api):
    t = new_chat(api)
    st = wait_run(api, ask(api, t["id"], "[forzar-error-modelo] Resume qué es un agujero negro")["id"])
    assert st["run"]["status"] == "completed"
    agent = st["agents"][0]
    assert agent["model"] != "@cf/meta/llama-3.3-70b-instruct-fp8-fast" and agent["fallback"] is True
    assert any("no respondió" in n for n in st["run"]["notices"])


def test_cancelar_y_una_peticion_a_la_vez(api):
    t = new_chat(api)
    run = ask(api, t["id"], "[lento] Investiga la historia de Roma y hazme un plan de estudio")
    busy = api.post(f"/api/chat/threads/{t['id']}/messages", json={"content": "otra"})
    assert busy.status_code == 409
    api.post(f"/api/chat/runs/{run['id']}/cancel")
    st = wait_run(api, run["id"])
    assert st["run"]["status"] == "cancelled"
    assert register().get(f"/api/chat/runs/{run['id']}").status_code == 404


def test_imagen_adjunta_activa_el_agente_de_vision(api):
    up = api.post("/api/images/upload", json={"data_url": PNG_1PX, "name": "captura.png"})
    assert up.status_code == 201
    t = new_chat(api)
    st = wait_run(api, ask(api, t["id"], "¿Qué ves en esta captura?", image_ids=[up.json()["id"]])["id"])
    assert st["run"]["status"] == "completed"
    assert st["agents"][0]["agent_id"] == "vision-analyst"
    other = register().post("/api/images/upload", json={"data_url": PNG_1PX}).json()["id"]
    r = api.post(f"/api/chat/threads/{t['id']}/messages", json={"content": "x", "image_ids": [other]})
    assert r.status_code == 422  # no se pueden adjuntar imágenes de otro usuario


# --- Estudio de imágenes -------------------------------------------------------------------------


def test_estudio_de_imagenes(api):
    meta = api.get("/api/images/models").json()
    caps = {c for m in meta["models"] for c in m["capabilities"]}
    assert {"t2i", "i2i", "inpaint"} <= caps and meta["limits"]["per_day"] == 20
    r = api.post("/api/images/generate", json={"mode": "t2i", "prompt": "Un faro al atardecer", "style": "cinematic", "width": 768, "height": 768, "model": "auto"})
    assert r.status_code == 201, r.text
    img = r.json()["image"]
    assert img["model"] == "@cf/black-forest-labs/flux-1-schnell" and img["mode"] == "t2i" and img["style"] == "cinematic"
    f = api.get(f"/api/images/{img['id']}/file")
    assert f.status_code == 200 and f.headers["content-type"] == "image/jpeg"
    assert register().get(f"/api/images/{img['id']}/file").status_code == 404
    # Sin modelo imagen→imagen gratuito: reinterpretación (visión + texto→imagen), avisada.
    r = api.post("/api/images/generate", json={"mode": "variation", "source_id": img["id"]})
    assert r.status_code == 201, r.text
    var = r.json()["image"]
    assert var["parent_id"] == img["id"] and var["mode"] == "variation" and var["model"] == "@cf/black-forest-labs/flux-1-schnell"
    assert any("Reinterpretación" in n for n in r.json()["notices"])
    edit = api.post("/api/images/generate", json={"mode": "i2i", "source_id": img["id"], "prompt": "en acuarela"})
    assert edit.status_code == 201 and edit.json()["image"]["mode"] == "i2i"
    # Upscale 2× hecho en el navegador: se guarda como derivada en la galería y no consume cuota.
    up = api.post("/api/images/upload", json={"data_url": PNG_1PX, "width": 1536, "height": 1536, "kind": "upscale", "parent_id": img["id"]})
    assert up.status_code == 201
    upm = api.get(f"/api/images/{up.json()['id']}").json()
    assert upm["mode"] == "upscale" and upm["parent_id"] == img["id"] and upm["width"] == 1536
    assert api.post("/api/images/upload", json={"data_url": PNG_1PX, "kind": "upscale", "parent_id": 999999}).status_code == 422
    assert api.post("/api/images/generate", json={"mode": "upscale", "source_id": img["id"]}).status_code == 422
    # Inpainting: necesita máscara y la API de OpenAI del usuario.
    assert api.post("/api/images/generate", json={"mode": "inpaint", "source_id": img["id"]}).status_code == 422
    inp = api.post("/api/images/generate", json={"mode": "inpaint", "source_id": img["id"], "mask_data_url": PNG_1PX, "prompt": "un barco"})
    assert inp.status_code == 422 and "OpenAI" in inp.json()["error"]
    assert api.get("/api/images/models").json()["limits"]["used_today"] == 3
    assert api.post("/api/images/generate", json={"mode": "i2i", "prompt": "x"}).status_code == 422
    assert api.patch(f"/api/images/{img['id']}", json={"saved": True}).json()["saved"] == 1
    assert [x["id"] for x in api.get("/api/images?saved=1").json()] == [img["id"]]
    assert api.post("/api/images/upload", json={"data_url": "data:text/html;base64,PGgxPg=="}).status_code == 422


def test_fallback_de_modelos_de_imagen(api):
    r = api.post("/api/images/generate", json={"mode": "t2i", "prompt": "[forzar-error-imagen] un gato"})
    assert r.status_code == 201
    body = r.json()
    assert body["fallback"] is True and body["image"]["model"] == "@cf/bytedance/stable-diffusion-xl-lightning"
    assert any("FLUX" in n for n in body["notices"])


def test_agente_de_edicion_en_el_hub_necesita_imagen(api):
    assert api.post("/api/hub/agents/image-editor/run", json={"input": "hazla acuarela"}).status_code == 422
    img = api.post("/api/images/upload", json={"data_url": PNG_1PX}).json()["id"]
    r = api.post("/api/hub/agents/image-editor/run", json={"input": "hazla acuarela", "image_ids": [img]})
    assert r.status_code == 201
    rid = r.json()["id"]
    for _ in range(60):
        run = api.get(f"/api/hub/runs/{rid}").json()
        if run["status"] in TERMINAL:
            break
        time.sleep(0.3)
    assert run["status"] == "completed" and run["output_kind"] == "image" and run["images"] == [img]


# --- API propia y prioridad ------------------------------------------------------------------------


def test_usar_mi_api_y_prioridad(api):
    s = api.get("/api/ai/settings").json()
    assert s == {"use_my_api": False, "priority": ["platform", "user_api", "free"]}
    assert api.put("/api/ai/settings", json={"priority": ["free", "free", "platform"]}).status_code == 422
    assert api.put("/api/providers/anthropic/key", json={"api_key": "sk-ant-api03-USERKEYFORTESTS000000"}).status_code == 200
    t = api.post("/api/chat/threads", json={"mode": "router"}).json()
    m = api.post(f"/api/chat/threads/{t['id']}/messages", json={"content": "hola"}).json()["message"]
    assert m["provider"] == "workers-ai"  # desactivado: configuración de la plataforma
    assert api.put("/api/ai/settings", json={"use_my_api": True}).json()["use_my_api"] is True
    m = api.post(f"/api/chat/threads/{t['id']}/messages", json={"content": "hola otra vez"}).json()["message"]
    assert m["provider"] == "claude-byok" and m["model"] == "claude-sonnet-5"
    # Prioridad: gratis por delante de mi API.
    api.put("/api/ai/settings", json={"priority": ["free", "platform", "user_api"]})
    m = api.post(f"/api/chat/threads/{t['id']}/messages", json={"content": "y ahora"}).json()["message"]
    assert m["provider"] == "workers-ai"
    status = api.get("/api/ai/status").json()
    assert status["own_keys"] == ["anthropic"] and "sk-ant" not in json.dumps(status)
    models = api.get("/api/ai/models").json()
    assert any(x["kind"] == "image" for x in models) and all("format" not in x for x in models)


def test_api_propia_con_pro_y_creditos_de_plataforma(api):
    make_pro(api)
    t = api.post("/api/chat/threads", json={"mode": "router"}).json()
    m = api.post(f"/api/chat/threads/{t['id']}/messages", json={"content": "hola"}).json()["message"]
    assert m["provider"] == "claude"  # plataforma primero


# --- Notificaciones ------------------------------------------------------------------------------------


def test_centro_de_notificaciones(api):
    s = api.get("/api/notifications/summary").json()
    assert s["unread"] == 1 and s["by_category"] == {"cuenta": 1}
    assert api.post("/api/auth/password", json={"current_password": PASSWORD, "new_password": "otra-contraseña-9"}).status_code == 200
    rows = api.get("/api/notifications?category=seguridad").json()
    assert rows[0]["title"] == "Contraseña cambiada" and rows[0]["priority"] == "high"
    assert api.get("/api/notifications?category=nope").status_code == 422
    api.post(f"/api/notifications/{rows[0]['id']}/read")
    assert api.get("/api/notifications?unread=1&category=seguridad").json() == []
    api.post("/api/notifications/read-all", json={})
    assert api.get("/api/notifications/summary").json()["unread"] == 0
    prefs = api.get("/api/notifications/prefs").json()
    for p in prefs:
        p["in_app"] = False
    assert api.put("/api/notifications/prefs", json={"prefs": prefs}).status_code == 200
    after = {p["id"]: p for p in api.get("/api/notifications/prefs").json()}
    assert after["seguridad"]["in_app"] is True and after["ia"]["in_app"] is False
    # Silenciada la categoría «cuenta» no se crean avisos de ese tipo; seguridad sí.
    api.post("/api/auth/password", json={"current_password": "otra-contraseña-9", "new_password": PASSWORD})
    assert api.get("/api/notifications/summary").json()["by_category"] == {"seguridad": 1}
    nid = api.get("/api/notifications").json()[0]["id"]
    assert api.delete(f"/api/notifications/{nid}").status_code == 200
    assert register().post(f"/api/notifications/{nid}/read").status_code == 200  # idempotente y sin efecto sobre otros


def test_sin_sesion_no_hay_acceso():
    c = httpx.Client(base_url=BASE)
    for url in ("/api/chat/agents", "/api/images/models", "/api/notifications", "/api/ai/settings"):
        assert c.get(url).status_code == 401
