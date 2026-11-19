// Groq por su API compatible con OpenAI (plan gratuito, sin tarjeta).

import { OpenAIProvider } from "./openai";

export class GroqProvider extends OpenAIProvider {
  id = "groq";
  name = "Groq";
  description = "Llama 3.3 70B, gpt-oss-120b y más, muy rápidos, con tu clave gratuita de Groq. Respaldo automático.";
  keyHelp = "Entra en console.groq.com → API Keys → Create API Key, cópiala (empieza por «gsk_…») y pégala aquí.";

  protected baseUrl(): string {
    return this.settings.groqBaseUrl;
  }
}
