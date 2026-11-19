// Google Gemini por su API compatible con OpenAI (plan gratuito con clave de Google AI Studio).

import { OpenAIProvider } from "./openai";

export class GeminiProvider extends OpenAIProvider {
  id = "gemini";
  name = "Google Gemini";
  description = "Modelos Gemini con tu clave gratuita de Google AI Studio. Respaldo automático cuando otras IAs no tienen saldo.";
  keyHelp = "Entra en aistudio.google.com → Get API key → Create API key, cópiala (empieza por «AIza…») y pégala aquí.";

  protected baseUrl(): string {
    return this.settings.geminiBaseUrl;
  }
}
