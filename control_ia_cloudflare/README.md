# Control IA en Cloudflare

Una web donde cualquiera puede crear su cuenta, **conectar sus propias IAs**
(Claude, GPT) y **sus repositorios de GitHub**, organizar sus productos en
proyectos y dejar que la IA los analice y proponga mejoras como **Pull
Requests**. Tú apruebas cada acción que publica o borra algo.

Todo corre en Cloudflare:

| Pieza | Servicio de Cloudflare |
|---|---|
| API + web | **Workers** (Hono) + **Static Assets** (`public/`) |
| Base de datos | **D1** (usuarios, proyectos, historial, conectores, auditoría) |
| Tareas de IA en segundo plano | **Queues** (hasta 15 min por invocación; las tareas largas se trocean solas) |

## Qué puede hacer cada usuario

1. **Registrarse** (registro abierto, se puede cerrar con `ALLOW_SIGNUP=false`).
2. **Conectar sus IAs** en *Configuración → Mis IAs*: su API key de Anthropic
   u OpenAI. Se guarda cifrada (AES-GCM), nunca vuelve al navegador y solo la
   usan sus proyectos. El consumo lo paga cada uno en su cuenta del proveedor.
3. **Crear proyectos** (uno por producto) con instrucciones, archivos,
   modelo, parámetros y límites propios.
4. **Conectar GitHub** con un token limitado a un repositorio, y habilitar en
   el proyecto las herramientas de repositorio:
   - *Repo: listar / leer archivo* — la IA lee el código (solo lectura).
   - *Repo: proponer cambios (PR)* — crea una rama nueva, escribe los archivos
     y abre un Pull Request. **Pide confirmación** y nunca toca la rama
     principal: el usuario revisa y fusiona en GitHub.
5. **Pedir trabajo a la IA** en el chat: «Analiza el repositorio y propón las 3
   mejoras más importantes». Ve el estado de cada tarea (pendiente,
   ejecutándose, esperando confirmación, completada, fallida), puede
   detenerla, cancelarla o reintentarla.
6. Conectar **Discord** o **Slack** para publicar resultados (con confirmación).

### Sobre «Claude Code»

Una web de terceros no puede usar la suscripción de Claude / Claude Code de
otra persona. Aquí cada usuario usa **su API key de Anthropic** y la
plataforma trabaja con Claude sobre **su repositorio** mediante herramientas
(leer código, proponer PRs). Es el mismo flujo de «hacer avanzar el producto»,
pero siempre con aprobación humana y sin push directo.

## Plataforma de IA: AI Chat, Agent Hub y Control IA Pro

```
AGENT HUB (catálogo) → AGENT REGISTRY → AGENT ADAPTER (runtime) → AI ROUTER → Claude | Cloudflare Workers AI
```

- **AI Router** (`src/ai/router.ts`): único punto que llama a un modelo. Orden:
  Claude con la clave propia del usuario → Claude de la plataforma (solo Pro,
  si `ANTHROPIC_API_KEY` existe y no está en enfriamiento) → modelo gratuito
  (`FREE_MODEL`) → respaldo gratuito (`FREE_MODEL_FALLBACK`). Si Claude falla
  por créditos, clave, límite o caída, se aparta un tiempo (tabla
  `provider_health`) y se usa el respaldo mostrando «Modelo premium no
  disponible · usando el modelo gratuito de respaldo». Al acabar el
  enfriamiento (o con *Métricas → reintentar claude ya*) vuelve a usar Claude
  sin tocar código. Cada llamada queda en `usage_events` (latencia, tokens,
  coste estimado, fallback, error).
- **Agent Registry** (`src/agents/registry.ts`): 56 agentes integrados en 18
  categorías (`src/agents/catalog/*.ts`) + agentes añadidos como manifiesto
  (tabla `hub_agents`). Un agente es un **manifiesto declarativo** (metadatos,
  instrucciones, etapas, herramientas permitidas, modelo preferido, respaldo,
  límites, versión, origen y licencia): nunca código de terceros.
- **Runtime** (`src/agents/runtime.ts`): ejecuta las etapas (PLANNING →
  RESEARCHING → ANALYZING → GENERATING → COMPLETED) en la cola, guarda el
  progreso para la interfaz y admite multiagente (maestro → subagentes en
  paralelo → síntesis final, profundidad 1).
- **Herramientas de agentes** (`src/agents/tools.ts`): Wikipedia (solo
  lectura, cita CC BY-SA), lector de páginas públicas cuya URL escribe el
  usuario, y generación de imágenes con FLUX.1 [schnell] (Apache-2.0). Ningún
  agente accede a secretos, base de datos, archivos, cuentas ni wallets, ni
  hace operaciones financieras reales.
- **AI Chat** (`src/chat.ts`): modos *auto*, *solo Claude*, *solo gratis* o
  *agente del Hub*; cada respuesta muestra proveedor, modelo y si hubo fallback.

### Añadir agentes

1. **En código** (revisado): crea o edita un archivo en `src/agents/catalog/`
   con `agent({...})` y, si sigue la metodología de un proyecto open source,
   `source: method("Nombre", "owner/repo", "MIT")`. Solo licencias de
   `COMPATIBLE_LICENSES`; nunca copies código ni prompts de otro repositorio.
2. **Como manifiesto** (admin, sin desplegar): *Agent Hub → fuentes y
   licencias → Añadir agente*. Pasa LICENSE → SECURITY → DEPENDENCY →
   COMPATIBILITY CHECK; queda *validado* y un admin lo *publica*.
3. **Update Checker**: la tabla `hub_sources` contiene ~5.700 repositorios
   descubiertos en listas awesome (solo el nombre). *Verificar licencias*
   descarga únicamente su archivo LICENSE y los clasifica (compatible,
   restringida, incompatible, no verificable). Nada se incorpora solo.

### Planes FREE / PRO y pagos

- Límites de cada plan: `src/plans.ts` (`PLAN_LIMITS`, `PRO_FEATURES`).
- Precio: **solo** en `wrangler.jsonc` → `PRO_MONTHLY_PRICE` (20) y
  `PRO_CURRENCY` (EUR). La web lo lee de `/api/billing/plans`.
- Página: `/upgrade`. Las ventajas aún inexistentes se marcan «Coming soon».
- Pagos: **desactivados** (`PAYMENT_PROVIDER=none`). `src/billing.ts` define
  la interfaz `PaymentProvider` y un `StripeProvider` (Checkout + webhook con
  firma verificada). Para activarlo: crea en Stripe un precio mensual de 20 €,
  `wrangler secret put STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, pon
  `STRIPE_PRICE_ID` y `PAYMENT_PROVIDER=stripe`, y registra el webhook
  `https://<tu-dominio>/api/billing/webhook/stripe` con los eventos
  `checkout.session.completed` y `customer.subscription.*`. Hasta entonces un
  admin puede dar Pro a mano (*Métricas → asignar plan*, sin cobro).
- Claude de la plataforma: `wrangler secret put ANTHROPIC_API_KEY`. Sin él,
  todo funciona con los modelos gratuitos.

## Desplegar en tu cuenta de Cloudflare

Requisitos: Node 20+ y una cuenta de Cloudflare (el plan gratuito sirve para
empezar; ver *Límites*).

```bash
npm install
npx wrangler login

# 1. Base de datos D1: copia el "database_id" que devuelve en wrangler.jsonc
npx wrangler d1 create control-ia

# 2. Cola de tareas
npx wrangler queues create control-ia-runs

# 3. Clave de cifrado (SECRETO: guárdala también en tu gestor de contraseñas)
openssl rand -base64 32          # copia el resultado
npx wrangler secret put ENCRYPTION_KEY

# 4. Tu email como administrador: edita "ADMIN_EMAILS" en wrangler.jsonc

# 5. Tablas y despliegue
npm run db:migrate:remote
npm run deploy
```

La web queda en `https://control-ia.<tu-subdominio>.workers.dev`.

**Dominio propio** (como stayliquid): Cloudflare → Workers & Pages →
`control-ia` → Settings → Domains & Routes → *Add → Custom domain* (por
ejemplo `ia.tudominio.com`).

**Despliegue automático desde GitHub** (opcional): sube esta carpeta a un
repositorio y en Workers & Pages → `control-ia` → Settings → Builds conecta el
repositorio. Cada push a `main` se despliega solo (las migraciones de D1 se
siguen aplicando con `npm run db:migrate:remote`).

> ⚠️ Si pierdes o cambias `ENCRYPTION_KEY`, las claves de IA y los tokens
> guardados dejan de poder descifrarse y los usuarios tendrán que volver a
> conectarlos.

## Configuración

Pública (`vars` en `wrangler.jsonc`): `ALLOW_SIGNUP`, `ADMIN_EMAILS`,
`COOKIE_SECURE`, `SESSION_HOURS`, `RUNS_PER_MINUTE`, `SIGNUPS_PER_HOUR_PER_IP`,
`LOGIN_ATTEMPTS_PER_MINUTE`, `PROVIDER_TIMEOUT_SECONDS`, `PROVIDER_MAX_RETRIES`,
`MAX_FILE_BYTES`, `ENABLE_DEMO_PROVIDER`, `OPENAI_BASE_URL`.

Plataforma de IA (`vars`): `FREE_MODEL`, `FREE_MODEL_FALLBACK`, `IMAGE_MODEL`,
`CLAUDE_MODEL`, `CLAUDE_MODEL_ADVANCED`, `PRO_MONTHLY_PRICE`, `PRO_CURRENCY`,
`PAYMENT_PROVIDER`, `PUBLIC_URL`. Binding `AI` (Workers AI).

Secretas (`wrangler secret put`): `ENCRYPTION_KEY` (obligatoria),
`ANTHROPIC_API_KEY` (opcional, Claude para Pro), `STRIPE_SECRET_KEY` y
`STRIPE_WEBHOOK_SECRET` (solo al activar pagos). Nunca llegan al navegador.

## Desarrollo local

```bash
npm install
node -e "console.log('ENCRYPTION_KEY='+require('crypto').randomBytes(32).toString('base64'))" > .dev.vars
echo "COOKIE_SECURE=false" >> .dev.vars
npm run db:migrate:local
npm run dev                         # http://127.0.0.1:8787
```

Tests de extremo a extremo contra el Worker local (D1 y Queues simulados por
Wrangler):

```bash
pip install pytest httpx
# en .dev.vars, para no gastar Workers AI ni Claude en los tests:
#   AI_MODE=mock
#   ADMIN_EMAILS=admin-tests@example.com
#   ANTHROPIC_API_KEY=sk-ant-mock
#   ANTHROPIC_BASE_URL=http://127.0.0.1:8799
python tests/mock_anthropic.py &    # imita Claude con y sin créditos
npx wrangler dev --local &
npm test
```

## Seguridad

- Contraseñas con PBKDF2-SHA256; sesiones con cookie HttpOnly + SameSite=Strict
  + Secure (en D1 solo su hash); CSRF en toda escritura; CSP estricta.
- Cada usuario solo ve sus proyectos, claves y conectores.
- Credenciales cifradas con AES-GCM; se redactan de errores, auditoría y logs.
- Lo que publica, envía datos a terceros o borra **siempre** pide
  confirmación; lo aplica el servidor (una acción aprobada no se ejecuta dos
  veces). Las lecturas del repositorio conectado no piden confirmación, pero
  hay que habilitarlas por proyecto.
- El contenido externo (archivos, código, webs, issues) se marca como datos,
  no como órdenes; la confirmación obligatoria es la defensa real.
- Límites: tareas/minuto por usuario, tareas/día por proyecto, pasos por
  tarea, registros por hora e IP, intentos de login, tamaño de archivos.

## Limitaciones conocidas

- **Plan gratuito de Workers:** 10 ms de CPU por invocación. Llamar a la IA es
  sobre todo espera de red (no cuenta como CPU), pero el hash de contraseñas y
  respuestas muy grandes pueden superarlo. Para uso real con más gente se
  recomienda **Workers Paid (5 $/mes)**.
- El flujo de GitHub (leer repo y abrir PR) está implementado contra la API
  real, pero en el desarrollo solo se verificó con tokens inválidos (errores
  401/404 claros); pruébalo con un repositorio tuyo antes de abrirlo a otros.
- No se ha ejecutado una tarea real con Claude/GPT (no había claves): se
  verificó que una clave inválida devuelve un error 401 claro.
- La interfaz consulta el estado cada 1,5 s (sin streaming token a token).
- Archivos del proyecto: solo texto UTF-8 (hasta 256 KB por defecto).
- Sin recuperación de contraseña por email (haría falta un servicio de correo).
- Ollama (IA local) no está disponible: un Worker no puede llegar a tu equipo.
- Workers AI cobra por uso a partir de la cuota gratuita diaria de la cuenta
  de Cloudflare (10.000 «neurons»/día); los límites FREE lo contienen.
- Los agentes «inspirados en» proyectos open source siguen su metodología
  pública con prompts propios: no ejecutan esos proyectos (son Python y no
  corren en Workers).
- Los pagos no están conectados: no se puede contratar Pro todavía.
- La salida de los agentes es texto plano (sin render Markdown).
