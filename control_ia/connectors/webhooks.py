"""Conectores de mensajería por webhook entrante (Discord y Slack).

Un webhook solo puede publicar en el canal para el que se creó: es el
permiso mínimo posible para "enviar un mensaje". La URL del webhook ES el
secreto (quien la tenga puede publicar), así que se guarda cifrada.
"""

from __future__ import annotations

from .base import Connector, ConnectorError, ConnectorType, FieldSpec


class DiscordWebhookConnector(Connector):
    type = ConnectorType(
        id="discord_webhook",
        name="Discord (webhook)",
        description="Publica mensajes en un canal concreto de Discord.",
        permissions=[
            "Publicar mensajes en el único canal asociado al webhook. No puede leer mensajes.",
            "Las menciones (@everyone, @here, usuarios y roles) se desactivan en cada envío.",
        ],
        setup_steps=[
            "En Discord: Ajustes del canal → Integraciones → Webhooks → Nuevo webhook.",
            "Copia la URL del webhook y pégala aquí. Se guarda cifrada y no se vuelve a mostrar.",
            "La prueba de conexión consulta el webhook (GET) y NO publica ningún mensaje.",
        ],
        fields=[
            FieldSpec(
                "webhook_url",
                "URL del webhook",
                secret=True,
                placeholder="https://discord.com/api/webhooks/…",
                pattern=r"https://(discord|discordapp)\.com/api/webhooks/\d+/[A-Za-z0-9_\-]+",
            ),
        ],
    )

    async def test(self) -> str:
        resp = await self._http("GET", self.secrets["webhook_url"])
        if resp.status_code in (401, 404):
            raise ConnectorError("Discord no reconoce este webhook: se borró o la URL es incorrecta.")
        if resp.status_code >= 400:
            raise ConnectorError(f"Discord respondió con error {resp.status_code}.")
        data = resp.json()
        return f"Webhook «{data.get('name', '?')}» activo (canal {data.get('channel_id', '?')})."

    async def send_message(self, content: str) -> str:
        resp = await self._http(
            "POST",
            self.secrets["webhook_url"],
            json={"content": content[:2000], "allowed_mentions": {"parse": []}},
        )
        if resp.status_code >= 400:
            raise ConnectorError(f"Discord rechazó el mensaje (error {resp.status_code}).")
        return "Mensaje publicado en Discord."


class SlackWebhookConnector(Connector):
    type = ConnectorType(
        id="slack_webhook",
        name="Slack (webhook)",
        description="Publica mensajes en un canal concreto de Slack.",
        permissions=[
            "incoming-webhook: publicar en el único canal elegido al crear el webhook. No puede leer nada.",
        ],
        setup_steps=[
            "En api.slack.com/apps crea una app → Incoming Webhooks → actívalo → "
            "Add New Webhook to Workspace.",
            "Elige el canal y copia la URL del webhook. Se guarda cifrada y no se vuelve a mostrar.",
            "La prueba envía una petición vacía que Slack rechaza sin publicar nada (respuesta «no_text»).",
        ],
        fields=[
            FieldSpec(
                "webhook_url",
                "URL del webhook",
                secret=True,
                placeholder="https://hooks.slack.com/services/…",
                pattern=r"https://hooks\.slack\.com/services/[A-Za-z0-9/]+",
            ),
        ],
    )

    async def test(self) -> str:
        # Un cuerpo sin texto: Slack valida el webhook y responde 400 no_text
        # sin publicar. Un webhook inválido responde 403/404.
        resp = await self._http("POST", self.secrets["webhook_url"], json={})
        body = resp.text.strip()
        if resp.status_code == 400 and body in {"no_text", "missing_text_or_fallback_or_attachments"}:
            return "Webhook de Slack válido (verificado sin publicar ningún mensaje)."
        if resp.status_code in (403, 404) or body in {"invalid_token", "no_service", "channel_not_found"}:
            raise ConnectorError(f"Slack no acepta este webhook ({body or resp.status_code}).")
        raise ConnectorError(f"Respuesta inesperada de Slack ({resp.status_code}).")

    async def send_message(self, content: str) -> str:
        resp = await self._http("POST", self.secrets["webhook_url"], json={"text": content[:3000]})
        if resp.status_code >= 400:
            raise ConnectorError(f"Slack rechazó el mensaje ({resp.text.strip()[:60] or resp.status_code}).")
        return "Mensaje publicado en Slack."
