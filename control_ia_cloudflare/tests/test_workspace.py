"""Tests del AI Agent OS: proyectos como espacios de trabajo, memoria, eventos,
validación, centro de comandos, stream del proyecto y preferencias."""

from __future__ import annotations

import json
import time

from test_api import Api, api, register  # noqa: F401 (api es un fixture)
from test_platform import mock_mode

TERMINAL = ("completed", "failed", "cancelled")


def project(api: Api, **kw) -> dict:
    body = {"name": "Web de recetas", "objective": "Lanzar una web de recetas saludables", "template": "software", **kw}
    r = api.post("/api/projects", json=body)
    assert r.status_code == 200, r.text
    return r.json()


def run_in(api: Api, pid: int, text: str) -> dict:
    r = api.post("/api/workspace/command/run", json={"text": text, "target": {"type": "project", "id": pid}})
    assert r.status_code == 202, r.text
    rid = r.json()["run"]["id"]
    for _ in range(150):
        d = api.get(f"/api/workspace/runs/{rid}").json()
        if d["run"]["status"] in TERMINAL:
            return d
        time.sleep(0.3)
    raise AssertionError("la ejecución no terminó")


def test_crear_proyecto_sin_modelo_ni_proveedor(api):
    tpls = api.get("/api/workspace/templates").json()
    assert {t["id"] for t in tpls} >= {"software", "marketing", "research", "content", "business", "data", "automation", "assistant", "custom"}
    p = project(api)
    assert p["provider"] == "" and p["model"] == "" and p["template"] == "software" and p["objective"].startswith("Lanzar")
    mem = api.get(f"/api/workspace/projects/{p['id']}/memory").json()
    assert len(mem) == 1 and mem[0]["kind"] == "preference"  # semilla de la plantilla
    custom = api.post("/api/projects", json={"name": "Solo nombre"}).json()
    assert custom["template"] == "custom" and api.get(f"/api/workspace/projects/{custom['id']}/memory").json() == []


def test_memoria_del_proyecto_y_permisos(api):
    p = project(api)
    m = api.post(f"/api/workspace/projects/{p['id']}/memory", json={"kind": "instruction", "content": "Usa modo oscuro"})
    assert m.status_code == 201
    mid = m.json()["id"]
    assert api.post(f"/api/workspace/projects/{p['id']}/memory", json={"kind": "nope", "content": "x y"}).status_code == 422
    assert api.patch(f"/api/workspace/memory/{mid}", json={"pinned": False}).json()["pinned"] == 0
    other = register()
    assert other.get(f"/api/workspace/projects/{p['id']}/memory").status_code == 404
    assert other.patch(f"/api/workspace/memory/{mid}", json={"content": "hack"}).status_code == 404
    assert other.delete(f"/api/workspace/memory/{mid}").status_code == 404
    assert api.delete(f"/api/workspace/memory/{mid}").status_code == 200


def test_ejecucion_en_proyecto_eventos_validacion_y_contexto(api):
    mock_mode("ok")
    p = project(api, name="Cafetería Luna", objective="Marca de café de especialidad en Madrid")
    api.post(f"/api/workspace/projects/{p['id']}/memory", json={"kind": "preference", "content": "Tono cercano"})
    d = run_in(api, p["id"], "Investiga la historia del café y crea un post para Instagram con imagen")
    assert d["run"]["status"] == "completed" and d["run"]["project_id"] == p["id"]
    assert d["run"]["task_type"] == "content"
    steps = {a["step"]: a for a in d["agents"]}
    assert steps["s1"]["role"] == "RESEARCHER" and steps["s2"]["role"] == "WRITER"
    assert all(a["why"] for a in d["agents"])  # «¿por qué este agente?»
    review = steps["review"]
    assert review["agent_id"] == "kairo-reviewer" and review["role"] == "REVIEWER" and review["status"] == "COMPLETED"
    assert sorted(review["depends_on"]) == ["s1", "s2"]
    types = [e["type"] for e in d["events"]]
    for t in ("RUN_STARTED", "PLAN_CREATED", "TASK_CREATED", "AGENT_WAITING", "AGENT_STARTED", "AGENT_WORKING", "AGENT_COMPLETED", "TASK_COMPLETED", "VALIDATION_STARTED", "VALIDATION_COMPLETED", "RUN_COMPLETED"):
        assert t in types, t
    assert types[0] == "RUN_STARTED" and types[-1] == "RUN_COMPLETED"
    assert [e["ms"] for e in d["events"]] == sorted(e["ms"] for e in d["events"])  # replay en orden
    plan = next(e for e in d["events"] if e["type"] == "PLAN_CREATED")
    assert [s["agent"] for s in plan["data"]["steps"]] == ["research-agent", "social-post-creator"]
    # Context filtering: el agente recibió el contexto del proyecto (el mock repite su entrada).
    assert "Cafetería Luna" in steps["s1"]["result"] or "Contexto del proyecto" in steps["s1"]["result"]
    # Resumen del proyecto con datos reales.
    ov = api.get(f"/api/workspace/projects/{p['id']}").json()
    assert ov["stats"]["runs"] == 1 and ov["stats"]["completed"] == 1 and ov["stats"]["agents_used"] == 3
    assert ov["latest"]["run"]["id"] == d["run"]["id"] and ov["last_result"]["run_id"] == d["run"]["id"]
    runs = api.get(f"/api/workspace/projects/{p['id']}/runs").json()
    assert runs[0]["request"].startswith("Investiga") and {a["agent_id"] for a in runs[0]["agents"]} == {"research-agent", "social-post-creator", "kairo-reviewer"}
    act = api.get(f"/api/workspace/projects/{p['id']}/activity").json()
    assert len(act) == len(d["events"])
    ag = api.get(f"/api/workspace/projects/{p['id']}/agents").json()
    used = {a["id"]: a["usage"] for a in ag["agents"] if a["usage"]["tasks"]}
    assert set(used) == {"research-agent", "social-post-creator"} and ag["reviewer"]["tasks"] == 1
    an = api.get(f"/api/workspace/projects/{p['id']}/analytics").json()
    assert an["per_day"][0]["runs"] == 1 and an["by_type"] == [{"type": "content", "runs": 1}]
    # El historial de chat del proyecto no se mezcla con el global.
    assert len(api.get(f"/api/chat/threads?project_id={p['id']}").json()) == 1
    assert all(t.get("project_id") is None for t in api.get("/api/chat/threads").json())


def test_una_sola_tarea_sin_validacion(api):
    p = project(api)
    d = run_in(api, p["id"], "Traduce al inglés: buenos días")
    assert [a["agent_id"] for a in d["agents"]] == ["translator"]
    assert "VALIDATION_STARTED" not in [e["type"] for e in d["events"]]


def test_centro_de_comandos(api):
    p = project(api)
    a = api.post("/api/workspace/command/analyze", json={"text": "Añade una sección de recetas veganas a la web"}).json()
    assert a["suggestion"] == "project" and a["project"]["id"] == p["id"]
    b = api.post("/api/workspace/command/analyze", json={"text": "Quiero crear una tienda online de camisetas"}).json()
    assert b["suggestion"] == "new" and b["new_name"].lower().startswith("tienda online") and b["template"] == "business"
    assert api.post("/api/workspace/command/analyze", json={"text": "hola"}).json()["suggestion"] == "standalone"
    r = api.post("/api/workspace/command/run", json={"text": "Crear una tienda online de camisetas", "target": {"type": "new", "name": "Tienda camisetas", "template": "business"}})
    assert r.status_code == 202 and r.json()["project_id"]
    newp = api.get(f"/api/projects/{r.json()['project_id']}").json()
    assert newp["name"] == "Tienda camisetas" and newp["template"] == "business"
    s = api.post("/api/workspace/command/run", json={"text": "hola", "target": {"type": "standalone"}})
    assert s.status_code == 202 and s.json()["project_id"] is None
    other = register()
    assert other.post("/api/workspace/command/run", json={"text": "x x", "target": {"type": "project", "id": p["id"]}}).status_code == 404
    assert api.post("/api/workspace/command/run", json={"text": "x x", "target": {"type": "raro"}}).status_code == 422


def test_stream_del_proyecto(api):
    p = project(api)
    api.post("/api/workspace/command/run", json={"text": "[lento] Resume qué es la fotosíntesis", "target": {"type": "project", "id": p["id"]}})
    states = []
    with api.c.stream("GET", f"/api/workspace/projects/{p['id']}/stream", timeout=60) as r:
        assert r.headers["content-type"].startswith("text/event-stream")
        for line in r.iter_lines():
            if line.startswith("data:"):
                st = json.loads(line[5:])
                states.append(st)
                if st and st["run"]["status"] in TERMINAL:
                    break
    assert states[-1]["run"]["status"] == "completed"
    assert len(states) >= 3 and all(s["run"]["project_id"] == p["id"] for s in states)
    assert states[-1]["events"][-1]["type"] == "RUN_COMPLETED"


def test_workspace_protegido(api):
    p = project(api)
    other = register()
    for url in (f"/api/workspace/projects/{p['id']}", f"/api/workspace/projects/{p['id']}/runs", f"/api/workspace/projects/{p['id']}/activity",
                f"/api/workspace/projects/{p['id']}/agents", f"/api/workspace/projects/{p['id']}/analytics", f"/api/workspace/projects/{p['id']}/stream"):
        assert other.get(url).status_code == 404, url
    d = run_in(api, p["id"], "hola")
    assert other.get(f"/api/workspace/runs/{d['run']['id']}").status_code == 404
    assert other.post("/api/chat/threads", json={"project_id": p["id"]}).status_code == 404


def test_preferencias_de_interfaz(api):
    assert api.get("/api/workspace/prefs").json() == {}
    prefs = {"theme": {"preset": "purple", "glow": 0.3}, "dashboard": {"modules": [{"id": "tasks", "on": True}], "layout": 2}}
    assert api.put("/api/workspace/prefs", json=prefs).status_code == 200
    assert api.get("/api/workspace/prefs").json() == prefs
    assert api.put("/api/workspace/prefs", json={"x": "a" * 21000}).status_code == 413
    home = api.get("/api/workspace/home").json()
    assert {"projects", "live", "recent_runs", "events", "tasks", "agents", "models", "usage_today"} <= set(home)
