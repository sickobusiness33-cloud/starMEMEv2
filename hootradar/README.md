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

## Política de severidad

Cada token observado recibe una puntuación de anomalía de 0 a 100. Con los umbrales por defecto:
**WATCH** desde 22 (solo aparece en la cinta de señales, sin noticia), **ALERT** desde 42 y
**BREAKING** desde 60 (ambos generan noticia).

- **Filtros de mercado.** Nunca se detecta nada con menos de `MIN_LIQUIDITY_USD` de liquidez o
  `MIN_VOLUME_H1_USD` de volumen en 1 h (10.000 $ cada uno), ni si la liquidez o el volumen son
  desconocidos, si el token está marcado como honeypot o tiene más de 7 días. Si la liquidez del
  mismo pool cae un 50 % o más dentro de la hora, el token se descarta (`Liquidity pulled`) y no se
  publica nada sobre él.
- **BREAKING exige tamaño real.** Una puntuación de BREAKING solo se publica como BREAKING si el
  pool tiene al menos `BREAKING_MIN_LIQUIDITY_USD` de liquidez (25.000 $) **y** al menos
  `BREAKING_MIN_VOLUME_H1_USD` de volumen en 1 h (75.000 $).
- **Topes en ALERT.** También se queda en ALERT cuando el top 10 de holders tiene el 80 % o más del
  supply, o cuando la autoridad de mint o la de congelación siguen activas. Solo cuentan los datos
  conocidos: un dato desconocido no es prueba y no aplica tope (la noticia lo señala como riesgo).
- **Transparencia.** Los motivos del tope viajan en `Detection.caps` y en `caps` del artículo. La web
  los muestra como chips ámbar `Capped at ALERT: <motivo>` en la tarjeta, en la noticia expandida y
  en el panel de detección de RADAR, junto a un medidor WATCH | ALERT | BREAKING.
- **Ritmo.** Un mismo token no recibe otra noticia antes de `ARTICLE_COOLDOWN_MIN` minutos salvo que
  escale de severidad o su puntuación suba con claridad, y hay un máximo global de
  `MAX_ARTICLES_PER_HOUR` noticias por hora.

## Umbrales relativos por cadena

La actividad típica de un lanzamiento depende de la cadena: un token nuevo en Solana mueve más
dinero por minuto que uno en Ethereum, Base o BNB Chain. Con una sola rampa global, el feed era solo
de Solana. Por eso la señal de lanzamiento (`fresh_launch`) usa una referencia propia por cadena:

- Cada cadena guarda el volumen por minuto de sus lanzamientos jóvenes (2–90 min de vida) que pasan
  los filtros de mercado, durante las últimas 6 horas. Al arrancar se siembra con los datos ya
  guardados.
- Con al menos 30 lanzamientos, la señal empieza a sumar en la mediana (p50) de la cadena y alcanza
  su peso completo en 1,25 × p90. Se recalcula como mucho cada 5 minutos.
- La referencia nunca se aleja más de 0,25×–2,5× de la calibración global (inicio en 10.000 $/min,
  peso completo en 50.000 $/min), así que una hora muerta o una granja de bots no puede convertir
  todos los lanzamientos en noticia. Con menos de 30 lanzamientos se usa la calibración global.
- Los filtros absolutos de mercado y la política de BREAKING siguen siendo los mismos en todas las
  cadenas.

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
| `AI_TIMEOUT_MS` | `45000` | Tiempo máximo por llamada a Claude; al superarlo escribe el motor de reglas. |
| `RADAR_WEB_RESEARCH` | `true` | Búsqueda web de Claude en RADAR (de pago por búsqueda). `false` deja solo los proveedores gratuitos. |
| `RADAR_AI_CALLS_PER_HOUR` | `60` | Presupuesto de llamadas a Claude (búsqueda web + resumen) que RADAR puede gastar por hora entre todos los visitantes. Al agotarse, RADAR omite la búsqueda web (lo indica en el estado de proveedores) y el resumen lo escribe el motor de reglas. |
| `CHAINS` | `solana,ethereum,base,bsc` | Cadenas a escanear. Un nombre desconocido detiene el arranque. |
| `MAX_TOKEN_AGE_HOURS` | `24` | Solo se siguen tokens más jóvenes que esto. |
| `MIN_LIQUIDITY_USD`, `MIN_VOLUME_H1_USD` | `10000`, `10000` | Filtros de mercado mínimos para cualquier detección. |
| `THRESHOLD_WATCH`, `THRESHOLD_ALERT`, `THRESHOLD_BREAKING` | `22`, `42`, `60` | Umbrales de severidad. Deben cumplir WATCH < ALERT ≤ BREAKING o el servidor no arranca. |
| `BREAKING_MIN_LIQUIDITY_USD`, `BREAKING_MIN_VOLUME_H1_USD` | `25000`, `75000` | Tamaño mínimo para publicar como BREAKING; por debajo se publica como ALERT (ver *Política de severidad*). |
| `ARTICLE_COOLDOWN_MIN`, `MAX_ARTICLES_PER_HOUR` | `30`, `30` | Pausa entre noticias del mismo token y tope global por hora. |
| `AUTOPUBLISH` | `true` | Publicar automáticamente. Solo acepta true/false (también 1/0, yes/no, on/off). |
| `TRUST_PROXY` | — (sin proxy) | Detrás de un proxy inverso: IPs/CIDRs del proxy separadas por comas (recomendado) o el número de saltos. Nunca se confía en todos los saltos: `true` equivale a 1 salto y deja un aviso en el log. Los límites por visitante dependen de esto. |
| `PUBLIC_BASE_URL` | — | URL pública que se enlaza en las publicaciones distribuidas. |
| `DISCORD_WEBHOOK_URL`, `TELEGRAM_BOT_TOKEN` + `TELEGRAM_CHAT_ID`, `DISTRIBUTION_WEBHOOK_URL` | — | Canales de distribución automáticos. X siempre queda como "listo para copiar". |
| `DISTRIBUTION_MIN_SEVERITY` | `BREAKING` | Severidad mínima que se envía automáticamente (`BREAKING` / `ALERT`). |

Un valor mal escrito (un número fuera de rango, una palabra que no es true/false, una cadena
desconocida) detiene el arranque con un error que nombra la variable, en vez de usar un valor por
defecto en silencio.

Límites fijos de la API pública: RADAR acepta 10 búsquedas por minuto por visitante y 60 por minuto
en total, ejecuta como mucho 4 investigaciones a la vez (si no, responde 503 con `Retry-After`) y cada
visitante puede lanzar 4 investigaciones con IA cada 10 minutos. Las conexiones en directo (SSE) están
limitadas a 6 por visitante y 1.000 en total. Las IPv6 se agrupan por /64.

## Aviso

HootRadar es una herramienta informativa. Nada de lo que muestra es asesoramiento financiero.
Los memecoins recién creados son extremadamente arriesgados: liquidez escasa, holders muy
concentrados y riesgo de rug pull.
