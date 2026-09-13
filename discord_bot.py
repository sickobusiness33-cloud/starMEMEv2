"""Bot de Discord: comandos, tareas periódicas y componentes de la UI.

Este módulo conecta las piezas de los demás (config, state, sources,
filters, tweets) con discord.py. No contiene lógica de negocio propia:
si algo se puede testear sin Discord, debería vivir en otro módulo.

Nota sobre asyncio.to_thread: sources.py usa `requests` (bloqueante), no
`aiohttp`. Si se llamara directamente desde una corrutina, cada petición
HTTP congelaría el bot entero (incluido el latido con Discord) mientras
espera respuesta. Por eso toda llamada a sources.* desde aquí pasa por
asyncio.to_thread, que la ejecuta en un hilo aparte sin bloquear el loop.
"""

from __future__ import annotations

import asyncio
import logging
from datetime import datetime, timezone

import discord
from discord.ext import commands, tasks

import sources
import tweets
from config import Settings
from filters import find_qualifying_token
from state import StateStore

logger = logging.getLogger(__name__)


def build_embed(token: dict, tweet_es: str, tweet_en: str | None = None) -> discord.Embed:
    mint = token.get("mint", "")
    embed = discord.Embed(
        title=f"🚨 Nueva alerta: {token.get('name')} (${token.get('symbol')})",
        description=(
            f"Market cap: **${token.get('_market_cap', 0):,.0f}**\n"
            f"Liquidez DEX: ${token.get('_liquidity', 0):,.0f}\n"
            f"Volumen 24h: ${token.get('_volume_24h', 0):,.0f}\n"
            f"[Ver en pump.fun](https://pump.fun/coin/{mint})"
        ),
        color=discord.Color.purple(),
    )
    embed.add_field(name="🇪🇸 Tweet (ES)", value=f"```{tweet_es}```", inline=False)
    if tweet_en:
        embed.add_field(name="🇬🇧 Tweet (EN)", value=f"```{tweet_en}```", inline=False)
    return embed


class CopyButton(discord.ui.Button):
    """Botón que manda el tweet en texto plano, fácil de copiar con un toque largo."""

    def __init__(self, label: str, text: str) -> None:
        super().__init__(label=label, style=discord.ButtonStyle.primary)
        self.text = text

    async def callback(self, interaction: discord.Interaction) -> None:
        await interaction.response.send_message(self.text, ephemeral=True)


def create_bot(settings: Settings) -> commands.Bot:
    """Construye el Bot de discord.py ya con comandos y tareas registradas.

    Todo vive dentro de esta función (en vez de a nivel de módulo) para que
    `settings` y `state` queden capturados por clausura, sin variables
    globales sueltas.
    """
    intents = discord.Intents.default()
    intents.message_content = True
    bot = commands.Bot(command_prefix="!", intents=intents)
    state = StateStore(settings.state_file)

    class RegenerateButton(discord.ui.Button):
        """Genera de nuevo el/los tweet(s) para la MISMA moneda, con otras palabras."""

        def __init__(self, token: dict, has_en: bool) -> None:
            super().__init__(label="🔄 Regenerar texto", style=discord.ButtonStyle.secondary)
            self.token = token
            self.has_en = has_en

        async def callback(self, interaction: discord.Interaction) -> None:
            tweet_es, error = tweets.generate_tweet(self.token, "es", settings.axiom_referral_link)
            if error:
                await interaction.response.send_message(f"⚠️ {error}", ephemeral=True)
                return
            tweet_en = None
            if self.has_en:
                tweet_en, _ = tweets.generate_tweet(self.token, "en", settings.axiom_referral_link)
            new_view = TweetView(self.token, tweet_es, tweet_en)
            await interaction.response.edit_message(
                embed=build_embed(self.token, tweet_es, tweet_en), view=new_view
            )

    class TweetView(discord.ui.View):
        def __init__(self, token: dict, tweet_es: str, tweet_en: str | None = None) -> None:
            super().__init__(timeout=None)
            self.add_item(CopyButton("📋 Copiar ES", tweet_es))
            if tweet_en:
                self.add_item(CopyButton("📋 Copiar EN", tweet_en))
            self.add_item(RegenerateButton(token, has_en=tweet_en is not None))

    @tasks.loop(seconds=settings.check_interval_seconds)
    async def watch_loop() -> None:
        if not state.can_alert_today(settings.max_alerts_per_day):
            return

        candidates = await asyncio.to_thread(sources.get_all_candidates)
        token, stats = find_qualifying_token(candidates, state.seen, settings)
        logger.info("watch_loop: %s", stats)
        if not token:
            return

        tweet_es, error = tweets.generate_tweet(token, "es", settings.axiom_referral_link)
        channel = bot.get_channel(settings.discord_channel_id)
        if not channel:
            logger.error("Canal no encontrado, revisa DISCORD_CHANNEL_ID.")
            return

        if error:
            await channel.send(
                f"⚠️ Token detectado ({token.get('symbol')}) pero no pude generar el tweet: {error}"
            )
            return

        await channel.send(embed=build_embed(token, tweet_es), view=TweetView(token, tweet_es))
        state.mark_alert_sent(token)

    @watch_loop.before_loop
    async def before_watch_loop() -> None:
        await bot.wait_until_ready()

    @tasks.loop(minutes=30)
    async def check_results_loop() -> None:
        """Revisa llamadas pasadas; si alguna petó, genera un tweet de "os lo dije"."""
        ahora = datetime.now(timezone.utc).timestamp()
        channel = bot.get_channel(settings.discord_channel_id)
        cambios = False

        for entrada in state.historial:
            if entrada.get("celebrado"):
                continue

            edad_horas = (ahora - entrada["timestamp"]) / 3600
            if edad_horas < settings.result_min_age_hours:
                continue

            if edad_horas > settings.result_max_age_days * 24:
                entrada["celebrado"] = True  # ya no lo comprobamos más
                cambios = True
                continue

            actual = await asyncio.to_thread(sources.get_current_stats, entrada["mint"])
            if not actual:
                continue

            cap_inicial = entrada.get("market_cap_inicial") or 0
            cap_actual = actual.get("market_cap") or 0
            if cap_inicial <= 0:
                continue

            pct_change = (cap_actual - cap_inicial) / cap_inicial * 100

            if pct_change >= settings.result_celebrate_pct and channel:
                tweet_es = tweets.generate_victory_tweet(
                    entrada["symbol"], pct_change, "es", settings.axiom_referral_link
                )
                tweet_en = tweets.generate_victory_tweet(
                    entrada["symbol"], pct_change, "en", settings.axiom_referral_link
                )
                embed = discord.Embed(
                    title=f"🏆 ¡{entrada['symbol']} ha petado! +{pct_change:.0f}%",
                    description="Toca presumir un poco. Tweet listo abajo 👇",
                    color=discord.Color.gold(),
                )
                embed.add_field(name="🇪🇸 Tweet (ES)", value=f"```{tweet_es}```", inline=False)
                embed.add_field(name="🇬🇧 Tweet (EN)", value=f"```{tweet_en}```", inline=False)
                view = discord.ui.View(timeout=None)
                view.add_item(CopyButton("📋 Copiar ES", tweet_es))
                view.add_item(CopyButton("📋 Copiar EN", tweet_en))
                await channel.send(embed=embed, view=view)
                entrada["celebrado"] = True
                cambios = True

        if cambios:
            state.save()

    @check_results_loop.before_loop
    async def before_check_results_loop() -> None:
        await bot.wait_until_ready()

    @bot.event
    async def on_ready() -> None:
        logger.info("Conectado como %s", bot.user)
        if not watch_loop.is_running():
            watch_loop.start()
        if not check_results_loop.is_running():
            check_results_loop.start()

    @bot.event
    async def on_command_error(ctx: commands.Context, error: commands.CommandError) -> None:
        """Sin esto, un cooldown o un fallo inesperado se queda solo en el log
        del servidor y quien escribió el comando no ve ninguna respuesta."""
        if isinstance(error, commands.CommandOnCooldown):
            await ctx.send(f"⏳ Espera {error.retry_after:.0f}s antes de repetir esto.")
            return
        if isinstance(error, commands.CommandNotFound):
            return
        logger.exception("Error ejecutando '%s'", ctx.message.content, exc_info=error)
        await ctx.send("⚠️ Algo falló ejecutando el comando. Revisa los logs.")

    @bot.command(name="resultados")
    async def resultados(ctx: commands.Context) -> None:
        """Muestra cómo han ido las últimas llamadas del bot."""
        historial = list(reversed(state.historial))[:10]
        if not historial:
            await ctx.send("Todavía no hay llamadas registradas.")
            return

        await ctx.send("🔍 Comprobando resultados...")
        lineas = []
        for entrada in historial:
            actual = await asyncio.to_thread(sources.get_current_stats, entrada["mint"])
            cap_inicial = entrada.get("market_cap_inicial") or 0
            if not actual or cap_inicial <= 0:
                lineas.append(f"${entrada['symbol']} — sin datos actuales")
                continue
            cap_actual = actual.get("market_cap") or 0
            pct_change = (cap_actual - cap_inicial) / cap_inicial * 100
            emoji = "🟢" if pct_change > 0 else "🔴"
            lineas.append(f"{emoji} ${entrada['symbol']}: {pct_change:+.0f}% desde la llamada")

        await ctx.send("**📊 Últimas llamadas:**\n" + "\n".join(lineas))

    @bot.command(name="scan")
    @commands.cooldown(1, 30, commands.BucketType.guild)
    async def manual_scan(ctx: commands.Context) -> None:
        """Fuerza una revisión manual ahora mismo (ignora el tope diario).

        Cooldown de 30s por servidor: consulta varias APIs externas y, con
        varios colaboradores usando el bot a la vez, evita que se solapen
        varios !scan y se agoten las peticiones sin necesidad.
        """
        await ctx.send("🔍 Buscando el mejor candidato ahora mismo...")
        candidates = await asyncio.to_thread(sources.get_all_candidates)
        token, stats = find_qualifying_token(candidates, state.seen, settings)
        if not token:
            await ctx.send(
                f"No hay ningún token que cumpla ahora mismo.\n"
                f"Candidatos totales: {stats['total']} | nuevos: {stats['nuevos']} | cumplen: {stats['cumplen']}\n"
                f"Prueba `!debug` para ver más detalle, o ajusta los umbrales con variables de entorno."
            )
            return
        tweet_es, error = tweets.generate_tweet(token, "es", settings.axiom_referral_link)
        if error:
            await ctx.send(f"⚠️ {error}")
            return
        tweet_en, _ = tweets.generate_tweet(token, "en", settings.axiom_referral_link)
        await ctx.send(embed=build_embed(token, tweet_es, tweet_en), view=TweetView(token, tweet_es, tweet_en))
        state.mark_alert_sent(token)

    @bot.command(name="token")
    @commands.cooldown(3, 15, commands.BucketType.user)
    async def manual_token(ctx: commands.Context, *, query: str | None = None) -> None:
        """Genera el tweet de UNA moneda concreta: !token <símbolo, nombre o dirección>"""
        if not query:
            await ctx.send("Uso: `!token $SYMBOL` o `!token DIRECCIÓN_DEL_CONTRATO`")
            return

        await ctx.send(f"🔍 Buscando **{query}**...")
        candidate = await asyncio.to_thread(sources.find_token_by_query, query)
        if not candidate or not candidate.get("mint"):
            await ctx.send("No lo encontré. Prueba con la dirección exacta del contrato.")
            return

        candidate["_market_cap"] = candidate.get("market_cap") or 0
        candidate["_liquidity"] = candidate.get("liquidity") or 0
        candidate["_volume_24h"] = candidate.get("volume_24h") or 0

        tweet_es, error = tweets.generate_tweet(candidate, "es", settings.axiom_referral_link)
        if error:
            await ctx.send(f"⚠️ {error}")
            return
        tweet_en, _ = tweets.generate_tweet(candidate, "en", settings.axiom_referral_link)
        await ctx.send(
            embed=build_embed(candidate, tweet_es, tweet_en),
            view=TweetView(candidate, tweet_es, tweet_en),
        )

    @bot.command(name="debug")
    @commands.cooldown(1, 30, commands.BucketType.guild)
    async def debug_sources(ctx: commands.Context) -> None:
        """Muestra cuántos candidatos da cada fuente, para diagnosticar."""
        await ctx.send("🔍 Consultando cada fuente por separado...")
        nombres = ["pump.fun", "DexScreener boosts", "DexScreener búsqueda"]
        listas = await asyncio.gather(
            asyncio.to_thread(sources.from_pumpfun),
            asyncio.to_thread(sources.from_dexscreener_boosts),
            asyncio.to_thread(sources.from_dexscreener_search, "solana meme"),
        )
        resultados = dict(zip(nombres, listas))
        lineas = [f"**{nombre}**: {len(lista)} tokens" for nombre, lista in resultados.items()]
        lineas.append(f"\nMarket cap mín: ${settings.min_market_cap_usd:,.0f}")
        lineas.append(f"Liquidez mín: ${settings.min_liquidity_usd:,.0f}")
        lineas.append(f"Volumen 24h mín: ${settings.min_volume_24h_usd:,.0f}")
        lineas.append(f"Transacciones 24h mín: {settings.min_txns_24h}")
        lineas.append(f"Ratio liquidez/cap mín: {settings.min_liq_mcap_ratio:.0%}")
        lineas.append(f"Edad mínima del par: {settings.min_pair_age_minutes:.0f} min")
        lineas.append(f"Edad máxima del par: {settings.max_pair_age_days:.0f} días")
        lineas.append(f"Caída máx. en 1h: -{settings.max_drop_1h_pct:.0f}%")
        await ctx.send("\n".join(lineas))

    @bot.command(name="estado")
    async def status(ctx: commands.Context) -> None:
        state.reset_counter_if_new_day()
        await ctx.send(
            f"Alertas hoy: {state.count_today}/{settings.max_alerts_per_day}\n"
            f"Market cap mín: ${settings.min_market_cap_usd:,.0f}\n"
            f"Liquidez mín: ${settings.min_liquidity_usd:,.0f}\n"
            f"Volumen 24h mín: ${settings.min_volume_24h_usd:,.0f}\n"
            f"Transacciones 24h mín: {settings.min_txns_24h}\n"
            f"Ratio liquidez/cap mín: {settings.min_liq_mcap_ratio:.0%}\n"
            f"Edad mínima del par: {settings.min_pair_age_minutes:.0f} min\n"
            f"Edad máxima del par: {settings.max_pair_age_days:.0f} días\n"
            f"Caída máx. en 1h: -{settings.max_drop_1h_pct:.0f}%"
        )

    return bot
