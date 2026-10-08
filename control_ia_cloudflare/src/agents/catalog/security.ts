// Agentes de seguridad: defensivos y educativos. No realizan ataques ni escaneos a terceros.
import { agent, instructions, S } from "./_helpers";

const DEF = "Solo ayudas con fines defensivos. No generas malware, exploits operativos ni instrucciones para atacar sistemas ajenos.";

export default [
  agent({
    id: "phishing-detector",
    name: "Phishing Detector",
    description: "Analiza un correo o mensaje sospechoso y te dice si parece phishing y por qué.",
    category: "security",
    color: "rosa",
    input: { label: "Pega el mensaje sospechoso", placeholder: "Remitente, asunto y texto…" },
    instructions: instructions("Eres analista de seguridad de correo.", DEF),
    stages: [S.generate("veredicto (probable phishing / sospechoso / legítimo), señales encontradas y qué hacer ahora", "(sin trabajo previo)")],
    capabilities: ["Señales de fraude", "Recomendaciones"],
  }),
  agent({
    id: "security-code-audit",
    name: "Security Code Audit",
    description: "Revisa código en busca de vulnerabilidades (inyección, XSS, secretos expuestos…) y propone arreglos.",
    category: "security",
    color: "naranja",
    tier: "pro",
    model: { prefer: "premium", advanced: true, allowFallback: true },
    input: { label: "Pega el código", placeholder: "..." },
    instructions: instructions("Eres auditor de seguridad de aplicaciones (OWASP).", DEF),
    stages: [S.plan("auditar el código"), S.generate("hallazgos por severidad con referencia OWASP/CWE, fragmento afectado y corrección")],
    capabilities: ["OWASP Top 10", "Correcciones"],
  }),
  agent({
    id: "password-policy",
    name: "Security Policy Helper",
    description: "Crea políticas de seguridad (contraseñas, accesos, copias) para una pyme, en lenguaje claro.",
    category: "security",
    color: "azul",
    input: { label: "Tu empresa y herramientas", placeholder: "Agencia de 8 personas, Google Workspace, portátiles propios" },
    instructions: instructions("Eres consultor de ciberseguridad para pymes.", DEF),
    stages: [S.plan("la política"), S.generate("la política por apartados y una checklist de implantación de 30 días")],
    capabilities: ["Políticas", "Checklist"],
  }),
];
