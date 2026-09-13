# STARmeme Bot

Vigila pump.fun 24/7, detecta meme coins de Solana con capitalización/liquidez
relevante y genera automáticamente un tweet listo para copiar y pegar. Lo
manda a un canal de Discord en cuanto lo detecta — no hace falta pedirlo.

## Comandos en Discord

| Comando | Qué hace |
|---|---|
| `!scan` | Fuerza una búsqueda ahora mismo (ignora el tope diario). Cooldown: 30s/servidor. |
| `!token <símbolo o dirección>` | Genera el tweet de una moneda concreta. Cooldown: 3 usos/15s por persona. |
| `!resultados` | Muestra cómo han ido las últimas llamadas. |
| `!estado` | Alertas enviadas hoy y umbrales configurados. |
| `!debug` | Cuántos candidatos da cada fuente de datos (para diagnosticar). Cooldown: 30s/servidor. |

Los cooldowns existen porque, con varios colaboradores usando el bot a la
vez, dos `!scan` solapados solo duplican peticiones a APIs externas sin
aportar nada nuevo.

## Cómo funciona por dentro

1. Consulta pump.fun ordenando por market cap.
2. Para cada token nuevo, cruza los datos con DexScreener para confirmar
   liquidez y volumen reales (evita tokens "inflados" artificialmente).
3. Si supera los umbrales configurados, redacta el tweet combinando
   plantillas propias (gancho + dato real + cierre + hashtags) con variación
   aleatoria, para que no suene siempre igual. No usa ninguna API de pago.
4. Publica el tweet en Discord dentro de un bloque de código, con botones
   para copiarlo con un toque o regenerarlo.
5. Guarda qué tokens ya alertó (`state.json`) para no repetirse, lleva un
   contador diario, y cada 30 min revisa si alguna llamada pasada "petó"
   para generar un tweet de seguimiento.

## Fiabilidad

- Las llamadas a pump.fun/DexScreener se hacen en un hilo aparte
  (`asyncio.to_thread`), así que si una API externa va lenta el bot no deja
  de responder al latido de Discord ni a otros comandos mientras espera.
- `from_pumpfun` verifica varios tokens EN PARALELO contra DexScreener (antes
  era uno a uno, y con 30 tokens y una API lenta podía tardar minutos).
- Cada petición reintenta hasta 2 veces con backoff antes de darse por
  vencida, y reutiliza la conexión (sesión HTTP compartida).
- Un error inesperado en un comando avisa en el canal en vez de fallar en
  silencio; el arranque valida la configuración (token, canal, intervalos)
  antes de conectar.

## Desplegar en Railway

Añade estas variables de entorno en el proyecto (ver `.env.example` para la
lista completa con sus valores por defecto):

| Variable | Obligatoria | Descripción |
|---|---|---|
| `DISCORD_TOKEN` | Sí | Token del bot de Discord. |
| `DISCORD_CHANNEL_ID` | Sí | ID del canal donde se publican las alertas. |
| `MIN_MARKET_CAP_USD` | No (default 30 000) | Capitalización mínima para alertar. |
| `MIN_LIQUIDITY_USD` | No (default 15 000) | Liquidez mínima confirmada en DEX. |
| `MIN_VOLUME_24H_USD` | No (default 20 000) | Volumen mínimo en 24h. |
| `MIN_TXNS_24H` | No (default 100) | Transacciones mínimas en 24h. |
| `MIN_LIQ_MCAP_RATIO` | No (default 0.03) | Liquidez mínima como proporción del market cap. |
| `MIN_PAIR_AGE_MINUTES` | No (default 15) | Antigüedad mínima del par (evita rugs recién creados). |
| `MAX_PAIR_AGE_DAYS` | No (default 5) | Antigüedad máxima del par. |
| `MAX_DROP_1H_PCT` | No (default 30) | Caída máx. en 1h para no descartar el candidato. |
| `MAX_ALERTS_PER_DAY` | No (default 10) | Tope de alertas/tweets al día. |
| `CHECK_INTERVAL_SECONDS` | No (default 300) | Cada cuánto revisa pump.fun. |
| `AXIOM_REFERRAL_LINK` | No | Link de referido que se añade al tweet. |
| `RESULT_CELEBRATE_PCT` | No (default 50) | Subida mínima para generar un tweet de seguimiento. |
| `RESULT_MIN_AGE_HOURS` | No (default 6) | Antes de esta edad no se comprueba el resultado. |
| `RESULT_MAX_AGE_DAYS` | No (default 7) | Después de esta edad se deja de comprobar. |

El `Procfile` y `railpack.json` ya apuntan a `python main.py`.

## Desarrollo local

Ver [CONTRIBUTING.md](CONTRIBUTING.md): instalación, cómo correr tests y
estructura del proyecto.

## Limitaciones importantes que debes saber

- **pump.fun no tiene una API pública oficial.** El endpoint que usa este
  bot (`frontend-api.pump.fun`) es el mismo que usa la web internamente;
  funciona hoy, pero pump.fun puede cambiarlo o bloquearlo sin aviso. Si un
  día deja de responder, es la primera causa a revisar (`!debug` ayuda a
  ver qué fuente está fallando).
- **Axiom no tiene API pública documentada**, así que no está integrado.
- **Robinhood no lista meme coins de pump.fun**, así que no aporta nada a
  este caso de uso y no se ha integrado.
- La publicación en X/Reddit **no está automatizada** a propósito: X cobra
  por su API de publicación y Reddit prohíbe el autoposteo puro sin
  interacción real (riesgo de shadowban/baneo). El bot deja el texto listo
  para pegar tú mismo.
- Esto es información pública de mercado, no asesoramiento financiero — el
  propio tweet generado incluye "NFA" por diseño.

## Próximos pasos posibles

- Añadir Reddit (vía PRAW) para sugerir también un post de subreddit.
- Guardar un historial de tokens alertados con resultado (subió/bajó) para
  ir afinando los umbrales automáticamente.
- Si en el futuro se quiere texto generado por IA sin plantillas fijas,
  Google Gemini tiene un nivel gratuito bastante generoso (no así Anthropic
  ni OpenAI).

## Contribuir

Las contribuciones son bienvenidas — ver [CONTRIBUTING.md](CONTRIBUTING.md).
