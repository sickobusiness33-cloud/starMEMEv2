# Kairo Autopilot — análisis de Medulla y arquitectura autónoma

## 1. Qué es Medulla (análisis del código)

| Aspecto | Lo que hay en el código |
|---|---|
| Lenguaje / tamaño | Rust, ~268.000 líneas (`src/link`, `src/sdk`, `src/tui`). |
| Licencia | **GPL-3.0-only**. Copiar su código dentro de Kairo obligaría a publicar Kairo entero bajo GPL. |
| Qué hace | Es una **terminal** que abre CLIs de agentes (Claude Code, Codex, OpenCode, shell) como sesiones PTY, en tu máquina o en otra por SSH + UDP. No es un motor de agentes propio: lanza programas que ya existen. |
| "Agentes" | Cada agente es un **proceso** (una CLI en un pseudo-terminal) con su directorio de trabajo. |
| Coordinación | Workflows JSON (grafo) ejecutados por el motor `tinyflows`. Nodos: `trigger`, `agent` (manda una tarea a una sesión real), `tool_call` (`medulla:shell` ejecuta scripts), `transform`, `loop` **acotado** (`max_iterations`), etc. `requires_approval: true` **aparca** el paso hasta que un humano lo aprueba. |
| Supervisión | "Attention cues": lee la pantalla de cada sesión para detectar prompts de permiso, `(y/n)`, límites de uso, cierres inesperados y tareas terminadas. |
| Memoria | Registros de ejecución, checkpoints y estado por paso en disco (`state/workflows/…`). No hay memoria semántica compartida entre agentes. |
| Planificación | La hace un humano (o un "copilot") escribiendo el grafo. No hay un orquestador que invente tareas solo. |
| Modelos | Selección por capa: paso → workflow → host (`harness` + `model` emparejados). |
| Capacidad real | `WorkspaceStrategy::max_sessions()` devuelve **1 por checkout** (las sesiones que comparten carpeta van en serie). OpenCode: `max_concurrency` = **4** por defecto. Sesiones abiertas: sin tope, limitadas por la máquina. **No hay nada en el código que hable de "1.000 agentes simultáneos"**; la única mención a "mil" es sobre tokens de un prompt. |
| Dependencias | `vendor/tinyflows`, `vendor/tinyagents` y `vendor/tinyhumans-sdk` son submódulos **vacíos en el zip**: el motor de workflows no viene incluido. |
| Servicio | La orquestación alojada es un servicio aparte, cerrado, gratis 30 días y luego de pago (Basic/Pro). |

## 2. Qué se puede reutilizar y qué no

**No reutilizable directamente**
- El código Rust: Kairo corre en Cloudflare Workers (JavaScript, sin procesos, sin PTY, sin disco, sin SSH). Además es GPL-3.0.
- Lanzar Claude Code / Codex / OpenCode: son programas de escritorio que necesitan una máquina con shell.
- `tinyflows`: no está en el zip.

**Reutilizable como diseño** (implementado desde cero en Kairo, sin copiar código)
- Tarea = una instrucción para un agente; plan = grafo con dependencias y paralelismo.
- Bucles **acotados** (máximo de iteraciones) en lugar de bucles libres.
- `requires_approval` → estado **NEEDS_APPROVAL** que aparca la tarea hasta que apruebes.
- "Attention cues" → contador de "esperando por ti" y estados WAITING/BLOCKED visibles.
- Selección de modelo por capa (rol → objetivo → plataforma) con fallback.
- Registro de cada ejecución (quién, qué, cuándo, resultado) y cancelación.

## 3. Qué trabajo REAL pueden hacer los agentes en Kairo

Los agentes no pueden ejecutar código en el servidor de Cloudflare (no hay sandbox de procesos). El trabajo real se hace a través de herramientas verificadas:

| Herramienta | Qué hace de verdad | Riesgo |
|---|---|---|
| `repo.list_files`, `repo.read_file` | Lee tu repositorio de GitHub (conector del proyecto) | LOW |
| `repo.list_issues` | Lee las issues abiertas | LOW |
| `web.read` | Lee una página pública | LOW |
| `memory.write` | Guarda conocimiento en la memoria persistente | LOW |
| `repo.create_issue` | Abre una issue con el problema encontrado | MEDIUM (auto + registro + revisión) |
| `repo.propose_pr` | Abre un Pull Request con cambios de código | HIGH (**requiere tu aprobación**) |
| `repo.ci_status` | Lee el resultado de los tests (GitHub Actions) de un PR | LOW |
| fusionar, desplegar, borrar datos, credenciales, wallets, pagos | — | **CRITICAL: bloqueado**, no existe herramienta |

Los **tests reales** se ejecutan en **GitHub Actions** (`.github/workflows/ci.yml`: TypeScript + suite de 64 tests) sobre cada PR que abran los agentes; el agente Testing lee el resultado con `repo.ci_status`.
Sin conector de GitHub, los agentes trabajan en modo análisis: investigan, planifican y documentan, y todo queda en resultados y memoria.

## 4. Infraestructura

Ya existente y reutilizada: Cloudflare Workers, D1 (base de datos), Queues (cola `control-ia-runs`), Workers AI, Model Router con fallback, conectores cifrados.
Añadido: **Cron Trigger** cada 5 minutos (`scheduled()`), tablas `ap_*` en D1, workflow de CI en GitHub.
No hace falta ningún servidor adicional: la autonomía 24/7 corre en Cloudflare aunque cierres el navegador.

## 5. Costes

- Workers AI gratis: **10.000 neuronas/día**. Un ciclo típico (planificar con Llama 8B + 3 tareas + revisión) consume del orden de cientos a pocos miles de neuronas; con modelos de 70B mucho más. El sistema **se detiene solo** cuando se agota el cupo y sigue al día siguiente.
- Workers Paid (5 $/mes) quita ese tope (0,011 $ por 1.000 neuronas extra).
- Claude/OpenAI (tu API o la de la plataforma): se paga por token; cada llamada queda registrada con tokens y coste estimado.
- Límites por objetivo: tokens/día, tareas por ciclo, ciclos por día, reintentos, concurrencia.

## 6. Limitaciones técnicas reales

- Concurrencia: la cola procesa **1 mensaje a la vez por lote**; Kairo limita a **3 tareas ejecutándose a la vez por usuario**. Es un sistema de decenas de tareas al día, no de miles de agentes simultáneos.
- CPU por invocación de Worker limitada; las llamadas a modelos son espera de red (no cuentan como CPU).
- Los agentes no ejecutan código ni tests en Cloudflare: los tests reales van en GitHub Actions.
- La calidad depende del modelo: con el modelo gratuito (Llama) los planes y parches son más flojos que con Claude.
- Todo lo que los agentes leen (código, web, issues) se trata como **dato no fiable** (protección contra prompt injection).

## 7. Arquitectura

```
TÚ (objetivos, aprobaciones)
   │
   ▼
Mission Control (frontend: solo panel, lectura + acciones)
   │  API /api/autopilot/*
   ▼
Cron (cada 5 min) ──► Cola ──► ORCHESTRATOR (ciclo por objetivo)
                                 OBSERVE  memoria + resultados + repo + issues
                                 PLAN     Planner (modelo de razonamiento, JSON validado)
                                 CREATE   tareas con rol, riesgo, dependencias, dedupe
                                 ASSIGN   rol → agente especializado (15 roles)
                                   │
                                   ▼  (cola, paralelo acotado, lease anti-duplicados)
                                 EXECUTE  agente + herramientas (riesgo validado)
                                 TEST     CI real en GitHub (si hay PR)
                                 REVIEW   Reviewer (aprueba / pide cambios)
                                 FIX      reintento con feedback → otro agente (Debugging) → escalado
                                 VERIFY   estado final + NEEDS_APPROVAL si hace falta
                                 MEMORY   resultados, decisiones, errores, soluciones
                                 NEXT     siguiente ciclo según cadencia y presupuesto
```

## 8. Cómo usarlo

1. **Conectores → GitHub**: token *fine-grained* limitado al repositorio, con permisos
   Contents (read/write), Pull requests (read/write), Issues (read/write) y Actions (read-only).
2. Vincula ese conector a un proyecto.
3. **Autopilot → + Objetivo**: elige el proyecto, la frecuencia y el presupuesto de tokens/día.
4. El cron (cada 5 min) abre ciclos; los agentes leen el código, investigan, abren issues
   (riesgo MEDIO) y **piden aprobación** para cada Pull Request (riesgo ALTO).
5. Al aprobar un PR, el agente Testing lee el resultado real de `.github/workflows/ci.yml`.
   Los PR nunca se fusionan solos.

Endpoints: `GET/POST /api/autopilot/goals`, `POST /api/autopilot/goals/:id/{start|pause|run|done}`,
`GET /api/autopilot/tasks`, `POST /api/autopilot/tasks/:id/{approve|reject|cancel}`,
`GET /api/autopilot/{events|memory|mission}`.

Tests: `tests/test_autopilot.py` (ciclo completo, memoria, bloqueo CRÍTICO, aprobación ALTO,
reintentos + escalado, permisos entre usuarios).
