# STARmeme Bot

Vigila pump.fun 24/7, detecta meme coins de Solana con capitalización/liquidez
relevante y genera automáticamente un tweet listo para copiar y pegar. Lo
manda a un canal de Discord en cuanto lo detecta — no hace falta pedirlo.

> Este repositorio incluye también **Control IA** (`control_ia/`), una
> plataforma web independiente para gestionar proyectos y asistentes de IA.
> Ver la sección [Control IA](#control-ia) más abajo.

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

---

# Control IA

Aplicación web para crear y organizar proyectos, elegir qué proveedor y
modelo de IA usa cada uno, conectar integraciones externas y controlar las
tareas de la IA con permisos y confirmaciones explícitas. Es independiente
del bot: no comparten código ni estado.

**Stack:** Python 3.11 + FastAPI + SQLite (stdlib) en el servidor; HTML/CSS/JS
sin dependencias ni compilación en el cliente. Se eligió para mantener el
lenguaje, las herramientas (ruff, pytest) y el despliegue en Railway del
repositorio, sin añadir Node ni una base de datos externa.

## Qué incluye

| Área | Funciones |
|---|---|
| **Proyectos** | Crear, editar, archivar/restaurar y eliminar (con confirmación escribiendo el nombre). Nombre, descripción, color, instrucciones del sistema, archivos, herramientas, conectores y límites propios. Búsqueda y filtro (activos/archivados/todos). |
| **Control de IA** | Proveedor y modelo por proyecto (lista real consultada a la API cuando hay credencial). Parámetros compatibles según el modelo (p. ej. `temperature` solo donde el modelo lo admite). Límites: tareas/día, mensajes de historial y pasos por tarea. |
| **Ejecuciones** | Estados: pendiente, ejecutándose, esperando confirmación, completada, fallida, detenida, cancelada. Detener, cancelar y reintentar. Historial por conversación, búsqueda en entradas/resultados/errores, copiar resultado o error. |
| **Conectores** | GitHub (token fine-grained de un repo), Discord (webhook) y Slack (webhook). Configurar, probar contra el servicio real, activar, desactivar y desconectar. Estado, último error, última prueba y último uso. Solo se activan tras una prueba correcta. |
| **Herramientas** | Activables por proyecto, con nivel de riesgo y permisos visibles: listar/leer archivos, guardar nota, eliminar archivo, leer URL pública, listar/crear issues en GitHub, enviar a Discord/Slack. |
| **Actividad** | Run log en vivo, cola/concurrencia, confirmaciones pendientes y auditoría (quién, qué, cuándo, resultado) con búsqueda. |
| **Configuración** | Credenciales de proveedores (solo admin), prueba de conexión, límites vigentes, usuarios y cambio de contraseña. |

## Instalación y arranque en local

```bash
python -m venv .venv && source .venv/bin/activate
pip install -r requirements-control.txt     # o requirements-dev.txt para tests
cp control_ia/env.example .env              # opcional: ajusta valores
export $(grep -v '^#' .env | xargs)         # si usas .env
python -m control_ia                        # http://127.0.0.1:8000
```

La primera vez no hay usuarios: el servidor escribe en el registro una línea
`token de instalación para crear el administrador: …`. Ábrelo en el
navegador, pega ese token y crea la cuenta. Alternativa por terminal:
`python -m control_ia crear-usuario tu@email.com --admin`.

Datos de demostración (opcionales, marcados como **DEMO**, sin secretos):
`python -m control_ia demo`. Usan el proveedor «Demostración local», que
**no es una IA**: devuelve respuestas fijas para probar estados, historial,
herramientas y confirmaciones. Comandos que entiende en el chat:
`/herramienta <nombre> {json}`, `/lento 10`, `/fallar`. Se puede ocultar con
`CONTROL_ENABLE_DEMO_PROVIDER=false`.

## Configurar credenciales reales

| Qué | Dónde se obtiene | Cómo se configura |
|---|---|---|
| Clave de cifrado | `python -c "from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())"` | Variable `CONTROL_SECRET_KEY`. Sin ella se crea `data/secret.key` (solo para local). Si se pierde, las credenciales guardadas no se pueden descifrar. |
| Anthropic (Claude) | console.anthropic.com → API Keys | Configuración → Proveedores (admin) o `ANTHROPIC_API_KEY`. |
| OpenAI | platform.openai.com → API keys | Configuración → Proveedores o `OPENAI_API_KEY` (`OPENAI_BASE_URL` para APIs compatibles). |
| Ollama | Instala Ollama y `ollama pull <modelo>` | Sin clave; `OLLAMA_BASE_URL` si no está en `127.0.0.1:11434`. |
| GitHub | Fine-grained token con acceso a UN repo: Metadata (read) + Issues (read, o read/write para crear) | Conectores → GitHub. |
| Discord | Ajustes del canal → Integraciones → Webhooks | Conectores → Discord. La prueba hace un GET y no publica. |
| Slack | api.slack.com/apps → Incoming Webhooks | Conectores → Slack. La prueba no publica (Slack responde `no_text`). |

Todas las credenciales se guardan cifradas (Fernet) en SQLite, nunca se
devuelven al navegador (la API solo indica si están guardadas) y se borran
de mensajes de error, auditoría y logs mediante redacción automática.

### Despliegue (p. ej. Railway)

Crea un **servicio aparte** del bot con comando de arranque
`pip install -r requirements-control.txt && python -m control_ia` (o
configúralo en el panel), variables `CONTROL_HOST=0.0.0.0`,
`CONTROL_COOKIE_SECURE=true`, `CONTROL_SECRET_KEY` y un **volumen
persistente** montado en `CONTROL_DATA_DIR`. El `Procfile` actual sigue
arrancando solo el bot.

## Seguridad y permisos

- **Autenticación:** sesiones con cookie HttpOnly + SameSite=Strict (hash en
  BD), contraseñas con scrypt, límite de intentos de login, CSRF en toda
  petición que modifica datos, cabeceras CSP/nosniff/frame-deny.
- **Autorización:** cada usuario solo ve sus proyectos y conectores. Solo
  los administradores gestionan claves de proveedores, usuarios y ven toda la
  auditoría.
- **Confirmaciones:** las herramientas externas, de publicación o destructivas
  requieren confirmación humana. Lo aplica el servidor: si la IA las pide, la
  ejecución queda en «esperando confirmación» y no se ejecuta nada hasta que
  alguien aprueba; si se ejecutan a mano, la API devuelve 428 sin
  `confirm=true`. Desconectar conectores y borrar archivos, conversaciones o
  proyectos también exige confirmación.
- **Contenido externo:** archivos, webs, issues y resultados de herramientas
  se envuelven como `<contenido_externo>` con la indicación de que no son
  órdenes, y el prompt del sistema lo refuerza. La defensa real es la
  confirmación obligatoria: un texto malicioso no puede publicar ni borrar
  nada sin que un humano lo apruebe.
- **Límites:** ejecuciones simultáneas, tareas por minuto y usuario, tareas
  por día y proyecto, pasos por tarea, timeout y reintentos con backoff ante
  errores 429/5xx del proveedor, tamaño de archivos; «Leer URL» bloquea IPs
  privadas/locales (SSRF).

## Arquitectura

```
control_ia/
  settings.py      configuración pública vs secretos (env)
  db.py            esquema SQLite y acceso
  security.py      scrypt, cifrado Fernet, redacción de secretos (texto y logs)
  auth.py          sesiones, CSRF, roles, usuarios
  projects.py      proyectos, archivos, herramientas/conectores por proyecto, conversaciones, búsqueda
  runs.py          cola de ejecuciones, ciclo de herramientas, confirmaciones, detener/cancelar/reintentar
  tools.py         registro de herramientas (riesgo, permisos, validación, ejecución)
  audit.py         registro de auditoría
  providers/       interfaz Provider + Anthropic (SDK oficial), OpenAI, Ollama, demo
  connectors/      interfaz Connector + GitHub, Discord, Slack
  static/          interfaz web (sin build)
```

Para añadir un proveedor, subclase de `Provider` en `providers/` y regístrala
en `PROVIDER_CLASSES`; para un conector, subclase de `Connector` con su
`ConnectorType` en `CONNECTOR_CLASSES`; para una herramienta, un `ToolSpec`
en `tools.TOOLS`. La interfaz los muestra automáticamente.

## Tests

```bash
pip install -r requirements-dev.txt
python -m pytest test_control_ia.py
```

Cubren: instalación y login, CSRF, aislamiento entre usuarios, separación de
instrucciones/historial entre proyectos, validación, errores de proveedor sin
configurar, fallo/reintento, detener, cancelar en cola, límites de uso,
confirmación y rechazo de acciones, herramientas no habilitadas, marcado de
contenido externo, flujo completo de conectores y que ningún secreto aparece
en respuestas, auditoría ni logs.

## Limitaciones conocidas

- **Sin credenciales incluidas.** Anthropic, OpenAI, GitHub, Discord y Slack
  necesitan tus propias claves; hasta entonces se muestran como «pendiente de
  configuración» y las tareas fallan con un error que indica qué falta. Con
  claves reales solo se verificó que la API responde con el error correcto
  ante una clave inválida (401); no se ha ejecutado una tarea real contra
  Claude ni GPT en este entorno.
- **Ollama** solo funciona si hay un servidor de Ollama accesible desde el
  backend.
- **Una sola instancia:** la cola de ejecuciones y los límites de uso viven en
  memoria del proceso. Con varias réplicas harían falta un broker (Redis/cola)
  y un límite compartido.
- **Sin streaming en la interfaz:** la respuesta aparece al terminar cada paso
  (la interfaz consulta el estado cada 1,5 s).
- **Detener** cancela la espera de la llamada en curso; el proveedor puede
  llegar a facturar los tokens ya generados.
- **Archivos:** solo texto UTF-8 (sin PDF ni imágenes), máximo configurable
  (256 KB por defecto).
- **«Leer página web»** comprueba que el destino resuelve a una IP pública
  antes de conectar, pero no protege contra DNS rebinding; no la habilites
  si el servidor tiene acceso a servicios internos sensibles.
- **Sin OAuth** en conectores: se usan tokens y webhooks, que dan el acceso
  mínimo sin registrar una app OAuth.
- **Sin recuperación de contraseña por email** (un admin puede crear otra
  cuenta; el usuario cambia su contraseña desde Configuración).
- La web usa fuentes de Google Fonts si hay conexión; si no, cae a las
  monoespaciadas del sistema.
