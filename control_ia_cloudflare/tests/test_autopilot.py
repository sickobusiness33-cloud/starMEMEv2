"""Tests del Kairo Autopilot (AI_MODE=mock): ciclo del orquestador, ejecución real de tareas
con herramientas, revisión, memoria, aprobación de riesgo ALTO, bloqueo CRÍTICO, reintentos
con escalado y Mission Control. Mismos requisitos que test_platform.py.
"""

from __future__ import annotations

import time

from test_api import Api, api, register  # noqa: F401 (api es un fixture)
from test_platform import mock_mode

DONE = ("done", "failed", "blocked", "cancelled", "needs_approval")


def goal(api: Api, title: str) -> int:
    r = api.post("/api/autopilot/goals", json={"title": title, "description": "Objetivo de prueba"})
    assert r.status_code == 201, r.text
    gid = r.json()["id"]
    assert api.post(f"/api/autopilot/goals/{gid}/start").status_code == 200
    return gid


def tasks(api: Api, gid: int) -> list[dict]:
    return api.get(f"/api/autopilot/tasks?goal={gid}").json()["tasks"]


def wait_tasks(api: Api, gid: int, n: int, timeout: float = 90) -> list[dict]:
    deadline = time.monotonic() + timeout
    ts: list[dict] = []
    while time.monotonic() < deadline:
        ts = tasks(api, gid)
        if len(ts) >= n and all(t["status"] in DONE for t in ts):
            return ts
        time.sleep(0.5)
    raise AssertionError(f"Tareas sin terminar: {[(t['id'], t['status']) for t in ts]}")


def test_ciclo_completo_tareas_reales_revision_y_memoria(api):
    mock_mode("ok")
    gid = goal(api, "Mejorar la documentación del proyecto")
    ts = wait_tasks(api, gid, 2)
    by = {t["role"]: t for t in ts}
    assert by["research"]["status"] == "done" and by["docs"]["status"] == "done"
    assert "memoria" in by["research"]["result"]
    # La tarea de docs dependía de la de research: empezó después de que ésta terminara.
    assert by["docs"]["id"] > by["research"]["id"]

    ev = api.get("/api/autopilot/events").json()["events"]
    kinds = {e["kind"] for e in ev}
    assert {"cycle", "delegate", "tool", "review"} <= kinds
    assert any(e["message"].startswith("memory.write") for e in ev if e["kind"] == "tool")

    mem = api.get(f"/api/autopilot/memory?goal={gid}").json()["memory"]
    assert any(m["kind"] == "knowledge" for m in mem) and any(m["kind"] == "result" for m in mem)

    m = api.get("/api/autopilot/mission").json()
    assert len(m["agents"]) == 15
    assert m["counts"]["done"] >= 2
    assert m["usage_24h"]["calls"] > 0
    # Sin tareas en marcha nadie aparece trabajando (nada simulado).
    assert all(a["state"] != "WORKING" for a in m["agents"] if a["id"] not in ("orchestrator", "planner"))


def test_riesgo_critico_bloqueado_alto_pide_aprobacion_y_reintentos_limitados(api):
    mock_mode("ok")
    gid = goal(api, "Objetivo con riesgos [mock-riesgo]")
    ts = wait_tasks(api, gid, 3, timeout=120)
    by = {t["title"]: t for t in ts}

    crit = next(t for k, t in by.items() if "api key" in k)
    assert crit["status"] == "blocked" and crit["risk"] == "critical"

    pr = next(t for k, t in by.items() if "[forzar-pr]" in k)
    assert pr["status"] == "needs_approval"
    assert pr["action"]["tool"] == "repo.propose_pr"

    bad = next(t for k, t in by.items() if "[forzar-fallo]" in k)
    assert bad["status"] == "failed"
    assert bad["escalated"] == 1 and bad["role"] == "coding"  # docs → coding tras 2 intentos
    ev = api.get("/api/autopilot/events").json()["events"]
    assert any(e["kind"] == "retry" for e in ev) and any(e["kind"] == "escalate" for e in ev)

    # Otro usuario no puede aprobar la acción
    other = register()
    assert other.post(f"/api/autopilot/tasks/{pr['id']}/approve").status_code == 409

    # Aprobada: se intenta de verdad y falla porque el objetivo no tiene repositorio conectado.
    r = api.post(f"/api/autopilot/tasks/{pr['id']}/approve")
    assert r.status_code == 409 and ("GitHub" in r.json()["error"] or "proyecto" in r.json()["error"])
    t = next(t for t in tasks(api, gid) if t["id"] == pr["id"])
    assert t["status"] == "failed"


def test_rechazo_pausa_y_permisos(api):
    mock_mode("ok")
    gid = goal(api, "Otro objetivo [mock-riesgo]")
    ts = wait_tasks(api, gid, 3, timeout=120)
    pr = next(t for t in ts if t["status"] == "needs_approval")
    assert api.post(f"/api/autopilot/tasks/{pr['id']}/reject", json={"reason": "no"}).status_code == 200
    assert next(t for t in tasks(api, gid) if t["id"] == pr["id"])["status"] == "cancelled"
    mem = api.get(f"/api/autopilot/memory?goal={gid}").json()["memory"]
    assert any(m["kind"] == "decision" and "rechazó" in m["content"] for m in mem)

    assert api.post(f"/api/autopilot/goals/{gid}/pause").status_code == 200
    g = next(g for g in api.get("/api/autopilot/goals").json()["goals"] if g["id"] == gid)
    assert g["status"] == "paused"

    other = register()
    assert other.post(f"/api/autopilot/goals/{gid}/start").status_code == 404
    assert other.get("/api/autopilot/tasks").json()["tasks"] == []
    assert api.delete(f"/api/autopilot/goals/{gid}").status_code == 200


def test_validacion_objetivo(api):
    assert api.post("/api/autopilot/goals", json={"title": "x"}).status_code == 422
    assert api.post("/api/autopilot/goals", json={"title": "Objetivo válido", "project_id": 999999}).status_code == 404
