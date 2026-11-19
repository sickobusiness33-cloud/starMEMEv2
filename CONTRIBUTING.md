# Contribuir a STARmeme

Gracias por echar una mano. Esto es un bot pequeño, así que el proceso es
deliberadamente ligero.

## Poner el proyecto en marcha en local

1. Clona el repo y entra en la carpeta.
2. Crea un entorno virtual e instala las dependencias de desarrollo:

   ```bash
   python -m venv .venv
   source .venv/bin/activate   # en Windows: .venv\Scripts\activate
   pip install -r requirements-dev.txt
   ```

3. Copia `.env.example` a `.env` y rellena `DISCORD_TOKEN` y
   `DISCORD_CHANNEL_ID` con los de un servidor de pruebas (no el de
   producción — así no generas alertas reales mientras desarrollas).

4. Carga las variables y arranca el bot:

   ```bash
   export $(grep -v '^#' .env | xargs)   # o usa una herramienta como direnv/python-dotenv
   python main.py
   ```

## Estructura del proyecto

| Archivo | Qué hace |
|---|---|
| `config.py` | Carga y valida las variables de entorno en un objeto `Settings`. |
| `state.py` | Guarda/lee `state.json` (tokens ya alertados, contador diario, historial). |
| `sources.py` | Llamadas HTTP a pump.fun y DexScreener. |
| `filters.py` | Decide qué candidato cumple los umbrales y cuál es el mejor. |
| `tweets.py` | Genera el texto del tweet a partir de plantillas. |
| `discord_bot.py` | Conecta todo lo anterior con discord.py: comandos, tareas periódicas, botones. |
| `main.py` | Punto de entrada (`python main.py`). |
| `control_ia/` | Plataforma web Control IA, independiente del bot (`python -m control_ia`). Ver su sección en el README. |

Si tu cambio es lógica pura (filtros, generación de texto, estado), debería
poder testearse sin tocar Discord — mira `filters.py`, `tweets.py` y
`state.py` como ejemplo.

**Importante:** `sources.py` usa `requests`, que es bloqueante. Si añades
una llamada nueva a `sources.*` desde `discord_bot.py`, envuélvela con
`await asyncio.to_thread(...)` (ver `watch_loop` como ejemplo) — si no, esa
llamada congela el bot entero (incluido el latido con Discord) mientras
espera respuesta.

## Antes de abrir un PR

```bash
ruff check .          # estilo y errores comunes
python -m pytest      # tests (bot + control_ia)
```

Ambos corren también en CI al abrir el PR (GitHub Actions), pero es más
rápido pillar los fallos en local. Opcionalmente, instala
[pre-commit](https://pre-commit.com) (`pip install pre-commit && pre-commit
install`) para que ruff corra solo en cada commit.

## Estilo

- Type hints en funciones nuevas.
- `logging` en vez de `print` para mensajes de diagnóstico.
- Comentarios y mensajes de cara al usuario en español (así ha sido siempre
  el proyecto); el código (nombres de variables/funciones) puede estar en
  inglés o español, lo que ya haya alrededor.

## Ideas abiertas

Ver la sección "Próximos pasos posibles" del README. Si vas a atacar una,
coméntalo antes en un issue para no duplicar trabajo.
