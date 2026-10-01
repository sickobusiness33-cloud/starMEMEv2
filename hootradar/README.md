# HootRadar — Crypto Intelligence Newsroom

**¿Qué está pasando AHORA MISMO en crypto?**

HootRadar es un noticiero cripto en tiempo real. Escanea varias blockchains sin parar,
detecta tokens y memecoins recién creados, analiza su actividad on-chain, la compara con
metodologías cuantitativas publicadas, investiga lo que se dice en Internet y convierte los
acontecimientos importantes en noticias cortas escritas por IA.

```
BLOCKCHAINS → DETECT → ANALYZE → QUANT → AI WRITE → PUBLISH (LIVE) → DISTRIBUTION QUEUE
```

Proyecto independiente: backend, base de datos, motor de IA y frontend propios.

## Las 3 pestañas

| Pestaña | Qué hace |
|---|---|
| **LIVE** | Noticias y eventos detectados en tiempo real (SSE). Tarjetas compactas con Market Cap, volumen, Tx/min, Buy/Sell, holders, QUANT MATCH y la línea de la IA. Al expandir: noticia completa, WHY IT MATTERS, QUANT ANALYSIS, AI OUTLOOK y versiones listas para cada canal. A la derecha, la cinta de señales, la latencia del pipeline y el estado de cada cadena. |
| **RADAR** | Buscador e investigador. Introduce un símbolo o una dirección de contrato y arranca la investigación por etapas: resolución → on-chain → holders → quant → web → informe IA. Las menciones en Internet se separan en LIVE / RECENT / OLD. |
| **INTELLIGENCE** | Motor cuantitativo: régimen de mercado, biblioteca de metodologías (momentum, reversión, trend following, breakout de volumen, volatilidad, liquidez, order flow, atención, régimen, gestión de riesgo) y los tokens que más se parecen hoy a cada una. |

## Principios

- **Sin datos falsos.** Todos los números salen de proveedores reales o se derivan de ellos. Si un dato no existe se muestra `—` con el motivo. Los contadores de la cabecera salen de la base de datos.
- **IA honesta.** La cabecera indica qué motor escribe: Claude (modelo concreto) o el motor de reglas. Ninguna noticia afirma que el precio vaya a subir; el outlook siempre trae escenario alcista, neutral y de riesgo.
- **Quant = similitud, no predicción.** QUANT MATCH mide el parecido de las condiciones actuales con las que busca una metodología publicada. No es una probabilidad de beneficio.
- **Quantpedia y artículos académicos con respeto a sus términos.** No hay scraping ni texto copiado. Cada metodología está descrita con palabras propias y enlaza al paper original y a la página pública de Quantpedia (solo cuando el enlace se ha verificado). Se puede conectar un feed con licencia (Quantpedia Pro/API) mediante la interfaz `QuantSource`.
- **Sin operaciones financieras automáticas.** La distribución solo publica texto.

## Fuentes de datos (gratuitas, sin clave)

GeckoTerminal (pools nuevos, holders, seguridad), DexScreener (métricas en lote, búsqueda, perfiles), pump.fun (lanzamientos en Solana), GDELT (noticias), Hacker News (comunidad), 4chan /biz/ (foro público). Opcional: con `ANTHROPIC_API_KEY`, Claude con `web_search` amplía la investigación a toda la web y redacta las noticias.

Cada cliente tiene su propio limitador de peticiones, timeouts y caché.

## Multichain

Solana, Ethereum, Base y BNB Chain. Cada cadena tiene su propio adapter (`server/src/chains/`). Para añadir una red nueva basta con su `ChainConfig` y, si hace falta, una fuente de descubrimiento propia.

## Arquitectura

```
hootradar/
  shared/types.ts      contrato de dominio común a server y web
  server/              Node 22 + TypeScript + Fastify + SQLite (node:sqlite)
    src/chains         adapters por blockchain
    src/sources        GeckoTerminal, DexScreener, pump.fun
    src/engine         scanner continuo, métricas, anomalías, pipeline, stats
    src/quant          biblioteca de metodologías, matcher, régimen, líderes
    src/ai             Claude (structured outputs + web search) y redactor por reglas
    src/research       RADAR: investigación por etapas + fuentes de Internet
    src/distribution   formatos X / Telegram / Discord / webhook + cola de envío
    src/http           API REST + Server-Sent Events + servido del frontend
  web/                 React 19 + Vite (NumberFlow, Sonner, zustand, Virtuoso)
  docs/                ARCHITECTURE.md (contratos), DESIGN.md (sistema visual)
```

Más detalle en [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) y [`docs/DESIGN.md`](docs/DESIGN.md).

## Puesta en marcha

Requisitos: Node ≥ 22.13.

```bash
cd hootradar
npm install
cp .env.example .env        # opcional: ANTHROPIC_API_KEY, webhooks de distribución
npm run dev                 # API en :8787 + web en :5173 (con proxy /api)
```

Producción (un solo proceso que sirve la API y el frontend compilado):

```bash
npm run build
npm start                   # http://localhost:8787
```

Tests y tipos:

```bash
npm test
npm run typecheck
```

## Configuración

Todas las variables están documentadas en [`.env.example`](.env.example). Las más importantes:

| Variable | Por defecto | Para qué |
|---|---|---|
| `ANTHROPIC_API_KEY` | — | Activa Claude para redactar noticias e investigar en la web. Sin clave, funciona entero con el motor de reglas. |
| `AI_MODEL` | `claude-opus-5-5` | Modelo de Claude. |
| `NEWS_LANG` | `es` | Idioma de las noticias (`es` / `en`). |
| `CHAINS` | `solana,ethereum,base,bsc` | Cadenas a escanear. |
| `THRESHOLD_*` | ver `.env.example` | Umbrales de WATCH / ALERT / BREAKING. |
| `DISCORD_WEBHOOK_URL`, `TELEGRAM_BOT_TOKEN` + `TELEGRAM_CHAT_ID`, `DISTRIBUTION_WEBHOOK_URL` | — | Canales de distribución automáticos. X siempre queda como "listo para copiar". |

## Aviso

HootRadar es una herramienta informativa. Nada de lo que muestra es asesoramiento financiero.
Los memecoins recién creados son extremadamente arriesgados: liquidez escasa, holders muy
concentrados y riesgo de rug pull.
