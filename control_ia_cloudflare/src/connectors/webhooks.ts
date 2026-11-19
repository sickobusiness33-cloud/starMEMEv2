// Conectores por webhook entrante: Discord y Slack. La URL del webhook ES el secreto.

import { Connector, ConnectorError, type ConnectorType } from "./base";

export class DiscordWebhookConnector extends Connector {
  static type: ConnectorType = {
    id: "discord_webhook",
    name: "Discord (webhook)",
    description: "Publica mensajes en un canal concreto de Discord.",
    permissions: [
      "Publicar en el único canal asociado al webhook. No puede leer mensajes.",
      "Las menciones (@everyone, @here, usuarios y roles) se desactivan en cada envío.",
    ],
    setup_steps: [
      "En Discord: Ajustes del canal → Integraciones → Webhooks → Nuevo webhook.",
      "Copia la URL del webhook y pégala aquí. Se guarda cifrada y no se vuelve a mostrar.",
      "La prueba consulta el webhook (GET) y NO publica ningún mensaje.",
    ],
    fields: [
      {
        name: "webhook_url",
        label: "URL del webhook",
        secret: true,
        placeholder: "https://discord.com/api/webhooks/…",
        pattern: "https://(discord|discordapp)\\.com/api/webhooks/\\d+/[A-Za-z0-9_\\-]+",
      },
    ],
  };

  async test() {
    const resp = await this.http(this.secrets.webhook_url);
    if (resp.status === 401 || resp.status === 404) throw new ConnectorError("Discord no reconoce este webhook: se borró o la URL es incorrecta.");
    if (!resp.ok) throw new ConnectorError(`Discord respondió con error ${resp.status}.`);
    const data: any = await resp.json();
    return `Webhook «${data.name ?? "?"}» activo (canal ${data.channel_id ?? "?"}).`;
  }

  async send(content: string) {
    const resp = await this.http(this.secrets.webhook_url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: content.slice(0, 2000), allowed_mentions: { parse: [] } }),
    });
    if (!resp.ok) throw new ConnectorError(`Discord rechazó el mensaje (error ${resp.status}).`);
    return "Mensaje publicado en Discord.";
  }
}

export class SlackWebhookConnector extends Connector {
  static type: ConnectorType = {
    id: "slack_webhook",
    name: "Slack (webhook)",
    description: "Publica mensajes en un canal concreto de Slack.",
    permissions: ["incoming-webhook: publicar en el único canal elegido al crear el webhook. No puede leer nada."],
    setup_steps: [
      "En api.slack.com/apps crea una app → Incoming Webhooks → actívalo → Add New Webhook to Workspace.",
      "Elige el canal y copia la URL. Se guarda cifrada y no se vuelve a mostrar.",
      "La prueba envía una petición vacía que Slack rechaza sin publicar nada («no_text»).",
    ],
    fields: [
      {
        name: "webhook_url",
        label: "URL del webhook",
        secret: true,
        placeholder: "https://hooks.slack.com/services/…",
        pattern: "https://hooks\\.slack\\.com/services/[A-Za-z0-9/]+",
      },
    ],
  };

  async test() {
    const resp = await this.http(this.secrets.webhook_url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    const body = (await resp.text()).trim();
    if (resp.status === 400 && ["no_text", "missing_text_or_fallback_or_attachments"].includes(body)) {
      return "Webhook de Slack válido (verificado sin publicar ningún mensaje).";
    }
    if ([403, 404].includes(resp.status) || ["invalid_token", "no_service", "channel_not_found"].includes(body)) {
      throw new ConnectorError(`Slack no acepta este webhook (${body || resp.status}).`);
    }
    throw new ConnectorError(`Respuesta inesperada de Slack (${resp.status}).`);
  }

  async send(content: string) {
    const resp = await this.http(this.secrets.webhook_url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: content.slice(0, 3000) }),
    });
    if (!resp.ok) throw new ConnectorError(`Slack rechazó el mensaje (${resp.status}).`);
    return "Mensaje publicado en Slack.";
  }
}
