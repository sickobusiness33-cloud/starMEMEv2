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
