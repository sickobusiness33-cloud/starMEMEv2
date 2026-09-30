// Roles del Autopilot. Un rol = responsabilidad + herramientas permitidas + riesgo máximo
// que puede ejecutar sin ti + modelo apropiado. Para añadir un agente nuevo basta con
// añadir una entrada aquí (el orquestador y el planificador leen esta tabla).
//
// `persona` reutiliza las instrucciones de un especialista del catálogo (agency-agents,
// MIT) como base de conocimiento; el rol añade encima las reglas del Autopilot.

import type { Capability } from "../ai/models";
import type { ApToolId, Risk } from "./policy";

export interface Role {
  id: string;
  name: string;
  purpose: string;
  persona?: string;          // id de agente del catálogo cuyas instrucciones se reutilizan
  capability: Capability;    // chat | code | reasoning → cadena de modelos del router
  cheap?: boolean;           // tarea simple → primero el modelo más barato
  tools: ApToolId[];         // herramientas que puede pedir
  plannable: boolean;        // el planificador puede asignarle tareas
}

const READ: ApToolId[] = ["repo.list_files", "repo.read_file", "repo.list_issues", "memory.write"];

export const ROLES: Role[] = [
  { id: "orchestrator", name: "Orchestrator", purpose: "Coordina el ciclo: observa, decide qué se hace, asigna, reintenta y escala.", capability: "reasoning", tools: [], plannable: false },
  { id: "planner", name: "Planner", purpose: "Divide el objetivo en tareas concretas, sin duplicar trabajo hecho.", persona: "sprint-prioritizer", capability: "reasoning", cheap: true, tools: [], plannable: false },
  { id: "research", name: "Research", purpose: "Investiga información externa y del repositorio para una decisión.", persona: "trend-researcher", capability: "chat", tools: [...READ, "web.read"], plannable: true },
  { id: "coding", name: "Coding", purpose: "Implementa cambios de código generales y propone Pull Requests.", persona: "senior-developer", capability: "code", tools: [...READ, "repo.propose_pr"], plannable: true },
  { id: "frontend", name: "Frontend", purpose: "Interfaz web (HTML/CSS/JS del panel) y su accesibilidad.", persona: "frontend-developer", capability: "code", tools: [...READ, "repo.propose_pr"], plannable: true },
  { id: "backend", name: "Backend", purpose: "API, Workers, colas y lógica de servidor.", persona: "backend-architect", capability: "code", tools: [...READ, "repo.propose_pr"], plannable: true },
  { id: "database", name: "Database", purpose: "Esquema D1, migraciones, índices y consultas.", persona: "database-optimizer", capability: "code", tools: [...READ, "repo.propose_pr"], plannable: true },
  { id: "security", name: "Security", purpose: "Revisa autenticación, secretos, permisos, inyección y dependencias.", persona: "appsec-engineer", capability: "reasoning", tools: [...READ, "repo.create_issue"], plannable: true },
  { id: "testing", name: "Testing", purpose: "Diseña tests y lee el resultado real de CI de los Pull Requests.", persona: "api-tester", capability: "code", tools: [...READ, "repo.ci_status", "repo.propose_pr"], plannable: true },
  { id: "debugging", name: "Debugging", purpose: "Encuentra la causa de un fallo y propone el cambio mínimo.", persona: "minimal-change-engineer", capability: "code", tools: [...READ, "repo.propose_pr"], plannable: true },
  { id: "uxui", name: "UX/UI", purpose: "Usabilidad, claridad y consistencia visual.", persona: "ux-architect", capability: "chat", tools: [...READ, "repo.create_issue"], plannable: true },
  { id: "performance", name: "Performance", purpose: "Rendimiento: consultas, tamaño de página, CPU, llamadas a modelos.", persona: "performance-benchmarker", capability: "code", tools: [...READ, "repo.create_issue"], plannable: true },
  { id: "docs", name: "Documentation", purpose: "Documentación técnica y de usuario.", persona: "technical-writer", capability: "chat", cheap: true, tools: [...READ, "repo.propose_pr"], plannable: true },
  { id: "monitoring", name: "Monitoring", purpose: "Salud del sistema: errores recientes, cupos, fallos de proveedores.", persona: "sre", capability: "chat", cheap: true, tools: ["repo.list_issues", "memory.write", "system.health"], plannable: true },
  { id: "reviewer", name: "Reviewer", purpose: "Revisa el resultado de cada tarea antes de darla por buena.", persona: "aa-code-reviewer", capability: "reasoning", cheap: true, tools: [], plannable: false },
];

export const ROLE_MAP = new Map(ROLES.map((r) => [r.id, r]));
export const PLANNABLE = ROLES.filter((r) => r.plannable);
/** Si el rol original falla dos veces, la tarea pasa a este (autorecuperación). */
export const ESCALATE_TO: Record<string, string> = { coding: "debugging", frontend: "debugging", backend: "debugging", database: "debugging", testing: "debugging", docs: "coding", research: "coding", uxui: "frontend", performance: "backend", security: "backend", monitoring: "research", debugging: "coding" };

export type { Risk };
