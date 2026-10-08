# Kairo Factory — Autonomous Project Factory

## 1. Auditoría del entorno (4 de octubre de 2026)

| # | Pregunta | Resultado real |
|---|---|---|
| 1 | Versión de ECC | **ECC 2.2.3** (affaan-m/ECC, MIT): 68 agentes, 293 skills, 94 comandos. Instalado en `.claude/` del repo KairoINTELLIGENCE y como plugin zip. Hooks **no** instalados (ejecutan scripts automáticamente). |
| 2 | Plugins / skills / agentes | ECC completo + skills de Anthropic (docs, pdf, xlsx, pptx, docx…), skill de Emil Kowalski (diseño), 1.514 agentes en el catálogo de Kairo, 15 roles del Autopilot, 16 agentes de la Fábrica. |
| 3 | Modelos | Workers AI (Llama 3.3 70B, Llama 3.1 8B, Mistral Small 3.1, Qwen2.5 Coder, QwQ, DeepSeek R1 Distill, gpt-oss 120B; FLUX/SDXL para imagen). Claude y OpenAI con tu clave (hoy **sin créditos**). |
| 4 | Repositorios | KairoINTELLIGENCE (privado), starMEMEv2, Interescompuesto, STARmeme, Pump_bot_Sicko — todos con escritura. |
| 5 | Desarrollo | Node 22, npm 10, Python 3.11, TypeScript, esbuild, wrangler 4.143, Playwright + Chromium, git. |
| 6 | Despliegue | Cloudflare Workers (token válido hasta 2-nov-2026, permiso Workers; **sin permiso D1** → el esquema de la fábrica se crea solo en tiempo de ejecución), cola `control-ia-runs`, cron cada 5 min, D1. Railway disponible por conector (no usado). |
| 7 | Seguridad | `tsc --noEmit`, 72 tests de integración, checks deterministas de la fábrica (XSS, scripts, secretos, orígenes, cabeceras), CSP sandbox, rate limiting en D1, agentes ECC `security-reviewer`/`security-scan`. No hay semgrep/gitleaks/trivy instalados. |
| 8 | Automatizable al 100 % | Ideas, investigación con datos reales, validación, diseño, construcción, QA, seguridad, publicación, verificación, sitemap, re-auditoría diaria, reparación, exportación a GitHub (rama `factory`). |
| 9 | Requiere humano | Pagar Claude / Workers Paid, comprar dominios, servicios de pago, acciones comerciales y operaciones financieras reales. |

## 2. Arquitectura

```
Tú (orden o nada)  ──►  /api/factory/command  ─┐
Cron cada 5 min    ──►  factoryTick ───────────┼─►  ideate (Research, datos reales DexScreener)
                                               │         │
                                               ▼         ▼
                         Cola control-ia-runs  {fxStep: id}  ──►  fxStep(stage)
  BACKLOG → RESEARCH (Product valida 1-10, descarta < 6)
          → BUILDING (Architecture + Marketing: producto y copy · UI/UX: identidad · Frontend: render seguro · Backend: APIs)
          → TESTING  (Testing + QA: 19 pruebas: SEO, a11y, contraste WCAG, peso, datos reales respondiendo)
          → SECURITY (9 controles: scripts, inline JS, on*, javascript:, iframes, secretos, orígenes, cookies, formularios)
          → DEPLOYING (SEO, DevOps publica versión, Deployment verifica la URL, Docs exporta a GitHub)
          → LIVE  ──(24 h)──► MAINTENANCE (Monitoring re-audita; si falla → vuelve a BUILDING sola)
  Fallo en QA/seguridad → vuelve a BUILDING con el informe (máx. 3 intentos) → si no, FAILED con el motivo.
```

- **Webs**: `https://control-ia.tureganovictor79.workers.dev/s/<slug>/`, escaparate en `/s/`, `sitemap.xml` en `/s/sitemap.xml`.
- **Aislamiento**: cada web se sirve con `Content-Security-Policy: sandbox …` → origen opaco: no puede leer tu sesión ni llamar a tu API privada.
- **Sin XSS por construcción**: el LLM nunca escribe HTML ni JS. Propone producto/copy/marca (JSON); `render.ts` lo valida y escapa; el único JS es `/fx-runtime.js` (auditado).
- **Datos reales**: `/fx/data/crypto/{trending,new,search,token,market}` → DexScreener y CoinGecko, normalizados, caché 45 s, nunca inventados.
- **IA de cada web**: `POST /fx/ai/<slug>` con límites (8/min por IP y web, 60/día por IP, 800/día por web).
- **Registro central**: tabla `fx_projects` (nombre, nicho, slug, URL, repo, etapa, estado, stack, APIs, checks, errores, versión, fechas de creación/publicación/auditoría) + `fx_events` (cada acción de cada agente).
- **Panel**: menú **Fábrica** → pantalla de color sólido con la red de 16 agentes (solo brillan si trabajan de verdad), carriles por etapa, registro, actividad en vivo y decisiones humanas.

## 3. Capacidad real

| Recurso | Límite | Webs/día aproximadas |
|---|---|---|
| Workers AI gratis (10.000 neuronas/día) | ~4 llamadas de modelo por web | **3-6** |
| Claude Sonnet con créditos | ~25-35k tokens por web | **34/día ≈ 1 M tokens ≈ 10-15 $/día** |
| Cola + cron de Workers | `max_parallel` (1-6) en paralelo | no es el cuello de botella |

El objetivo diario (`daily_target`) y el presupuesto de tokens (`token_budget_day`) se configuran en **Ajustes**: la fábrica nunca se pasa.

## 4. Cómo se usa

1. Menú **Fábrica** → **Arrancar** (o escribe «Crea proyectos nuevos de meme coins» y **Ejecutar**).
2. Ajustes: objetivo diario (p. ej. 34), en paralelo, presupuesto de tokens, nichos y prioridad, color de la pantalla, exportar a GitHub.
3. Para el volumen alto: activa créditos de Claude y «Usar mi API» en Ajustes de Kairo.

## Misiones (órdenes permanentes)

Escribe una orden en la barra de la Fábrica y se convierte en una **misión diaria** que se repite sola, todos los días, hasta que pulses **Parar**:

| Orden | Qué crea cada día |
|---|---|
| «Créame una criptomoneda» | 10 meme coins (por defecto): nombre, ticker, logo propio (FLUX.1 schnell), lore, rasgos de la mascota, tokenomics propuesta, roadmap, ideas de comunidad, chat con la mascota y web publicada en `/s/<slug>/`. |
| «Hazme webs de deportes» | 5 webs (por defecto) del nicho, con el pipeline completo (research → build → QA → seguridad → deploy). |
| «8 webs de IA al día» | El número de la orden fija el cupo diario (1–50). |

- El cron (cada 5 min) rellena el cupo de cada misión en tandas de 3; varias misiones corren en paralelo.
- Parar una misión pausa lo que estaba a medias; lo publicado sigue online. Borrarla conserva lo creado.
- Modelos: Claude si hay créditos (plataforma o «Usar mi API»); si no, los más potentes gratuitos de Workers AI (gpt-oss-120b para razonar, Llama 3.3 70B, FLUX para logos).
- **Las meme coins son conceptos**: no se despliega ningún token en una blockchain. La web lo dice claramente. Lanzarlo on-chain es una operación financiera que solo puede autorizar el dueño.

## Coin Studio (apartado propio)

Menú → **Coin Studio**. Escribe cualquier temática ("gatos samuráis", "fútbol callejero", "una IA rebelde"…), elige cuántas al día (1–50) y pulsa **Empezar a crear**. Cada moneda pasa por:

1. **Director creativo**: nombre, ticker, mascota, historia, eslóganes, tokenomics, roadmap, comunidad, identidad visual y estilo (sticker, neon, pastel o luxe).
2. **Editor jefe**: puntúa el borrador (0–10) y reescribe lo flojo (autocrítica).
3. **Ilustrador (FLUX.1 schnell, gratis)**: logo, ilustración de la historia y meme.
4. **Web de lanzamiento** (`src/factory/coinsite.ts` + `public/fx-coin.css`): hero con mascota, marquesina, historia ilustrada, tokenomics con gráfico de anillo, roadmap, comunidad, chat con la mascota, mercado real y FAQ.
5. QA + seguridad + publicación en `/s/<slug>/` (imágenes en `/s/<slug>/logo|art|meme`).

Coste aproximado por moneda en Workers AI: ~400–600 neuronas (el cupo gratis de 10.000/día da para unas 15–20 monedas). Con créditos de Claude, el director y el editor pasan a Claude automáticamente.
