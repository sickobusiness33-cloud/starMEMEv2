# Avisos de terceros

Control IA no incluye código de terceros aparte de sus dependencias npm
(ver `package.json`). Usa estos modelos y servicios, y cita estas fuentes:

## Modelos (vía Cloudflare Workers AI)

- **Llama 3.3 70B Instruct** y **Llama 3.1 8B Instruct** — Meta,
  Llama 3.3 / Llama 3.1 Community License. *Built with Llama.*
- **FLUX.1 [schnell]** — Black Forest Labs, Apache-2.0.
- **Mistral Small 3.1 24B Instruct** — Mistral AI, Apache-2.0.
- **Qwen2.5 Coder 32B Instruct**, **QwQ 32B** — Qwen (Alibaba Cloud), Apache-2.0.
- **DeepSeek R1 Distill Qwen 32B** — DeepSeek, MIT.
- **gpt-oss 120B** — OpenAI (pesos abiertos), Apache-2.0.
- **Stable Diffusion XL base 1.0**, **SDXL Lightning** (ByteDance) — CreativeML Open RAIL++-M.
- **DreamShaper 8 LCM** (Lykon) — CreativeML Open RAIL-M.

Las licencias OpenRAIL permiten uso comercial con restricciones de uso: no se
pueden usar para generar contenido ilegal, dañino, que suplante a personas o
que infrinja derechos. Esas restricciones se trasladan a los usuarios de Control IA.

## Servicio comercial

- **Claude** — Anthropic (API). Solo con la clave de la plataforma o la del
  propio usuario.

## Contenido

- **Wikipedia** — textos bajo CC BY-SA 4.0; los agentes citan la URL de cada
  artículo usado.

## Metodologías de referencia (sin código ni prompts copiados)

Algunos agentes siguen el patrón de trabajo publicado por estos proyectos; la
implementación y los prompts son propios de Control IA:

| Proyecto | Licencia |
|---|---|
| STORM (stanford-oval/storm) | MIT |
| GPT Researcher (assafelovic/gpt-researcher) | Apache-2.0 |
| TradingAgents (TauricResearch/TradingAgents) | Apache-2.0 |
| AI Hedge Fund (virattt/ai-hedge-fund) | MIT |
| FinRobot (AI4Finance-Foundation/FinRobot) | Apache-2.0 |
| MetaGPT (geekan/MetaGPT) | MIT |
| ChatDev (OpenBMB/ChatDev) | Apache-2.0 |
| CAMEL (camel-ai/camel) | Apache-2.0 |
| CrewAI (crewAIInc/crewAI) | MIT |
| AutoGen (microsoft/autogen) | MIT (código) |
| LangGraph (langchain-ai/langgraph) | MIT |
| Browser Use (browser-use/browser-use) | MIT |
| Aider (Aider-AI/aider) | Apache-2.0 |
| Swarm (openai/swarm) | MIT |

La lista completa de proyectos analizados (incluidos los excluidos por
licencia) está en `src/agents/sources.ts` y en la web: *Agent Hub → fuentes y
licencias*.

## agency-agents (personas de agentes especialistas)

209 agentes del Agent Hub (categorías Design, Sales, Product, Support, Testing & QA,
Game Dev, Academic, Spatial / XR, Specialists y parte de Coding, Marketing, Finance,
Security y Productivity) se generan a partir de las personas de
[msitarzewski/agency-agents](https://github.com/msitarzewski/agency-agents)
con `scripts/import_agency_agents.py`. Se adaptan (idioma, formato y longitud) y
solo se importa texto; no se incluye código del proyecto.

MIT License — Copyright (c) 2026 Michael Sitarzewski

Permission is hereby granted, free of charge, to any person obtaining a copy of
this software and associated documentation files (the "Software"), to deal in the
Software without restriction, including without limitation the rights to use,
copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the
Software, and to permit persons to whom the Software is furnished to do so,
subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS
FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR
COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN
AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION
WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.

## three.js (oficina 3D)

`public/vendor/three.min.js` es three.js 0.186.1 empaquetado sin cambios.
MIT License — Copyright © 2010-2026 three.js authors. https://github.com/mrdoob/three.js

## agent-directory (lista de nombres)

Los nombres de los agentes de `src/agents/catalog/directory.ts` proceden de la lista pública
«agent-directory». Ese repositorio no declara licencia, por lo que **no se ha copiado ningún texto**:
solo se usan los títulos genéricos de los agentes (p. ej. «Meal Planner») y su sector.
Descripciones, instrucciones y etapas son plantillas propias de Control IA
(`src/agents/catalog/_directory.ts`, `scripts/import_agent_directory.py`).
