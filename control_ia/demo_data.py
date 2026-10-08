"""Datos de demostración opcionales (`python -m control_ia demo`).

No contienen secretos y todos los proyectos se marcan con is_demo=1 y el
prefijo «[DEMO]», que la UI muestra como etiqueta.
"""

from __future__ import annotations

from .context import AppContext
from .db import dumps, now_iso

DEMO_PROJECTS = [
    {
        "name": "[DEMO] Soporte al cliente",
        "description": "Ejemplo: redactar respuestas a tickets con tono cercano.",
        "instructions": "Responde en español, con tono cercano y en menos de 120 palabras.",
        "color": "turquesa",
        "tools": ["archivos_listar", "archivos_leer"],
    },
    {
        "name": "[DEMO] Notas de lanzamiento",
        "description": "Ejemplo: convertir listas de cambios en notas de versión.",
        "instructions": "Escribe en inglés técnico, con viñetas agrupadas por Added / Fixed / Changed.",
        "color": "morado",
        "tools": ["archivos_listar", "notas_guardar", "archivos_eliminar"],
    },
]


def seed_demo(ctx: AppContext) -> str:
    admin = ctx.db.one("SELECT id FROM users WHERE role = 'admin' ORDER BY id LIMIT 1")
    if not admin:
        return "Primero crea un administrador (arranca la app o usa `crear-usuario --admin`)."
    created = 0
    for spec in DEMO_PROJECTS:
        if ctx.db.one("SELECT id FROM projects WHERE owner_id = ? AND name = ?", (admin["id"], spec["name"])):
            continue
        now = now_iso()
        pid = ctx.db.execute(
            "INSERT INTO projects (owner_id, name, description, instructions, color, provider, model,"
            " params_json, limits_json, is_demo, created_at, updated_at)"
            " VALUES (?, ?, ?, ?, ?, 'demo', 'demo-eco', ?, '{}', 1, ?, ?)",
            (
                admin["id"],
                spec["name"],
                spec["description"],
                spec["instructions"],
                spec["color"],
                dumps({"max_tokens": 4096}),
                now,
                now,
            ),
        )
        for tool_id in spec["tools"]:
            ctx.db.execute("INSERT INTO project_tools (project_id, tool_id) VALUES (?, ?)", (pid, tool_id))
        ctx.db.execute(
            "INSERT INTO project_files (project_id, name, content, size, include_in_context, created_by,"
            " created_at)"
            " VALUES (?, 'LEEME-demo.md', ?, ?, 1, 'demo', ?)",
            (
                pid,
                "Archivo de ejemplo del proyecto de demostración.",
                len("Archivo de ejemplo del proyecto de demostración.".encode()),
                now,
            ),
        )
        created += 1
    return (
        f"{created} proyectos de demostración creados (usan el proveedor «Demostración local», que no es IA)."
    )
