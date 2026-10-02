// Conector GitHub: un repositorio con un token fine-grained.
// Permite a la IA leer el código y proponer cambios como Pull Request.

import { Connector, ConnectorError, type ConnectorType } from "./base";

const API = "https://api.github.com";

function b64Utf8(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

export class GitHubConnector extends Connector {
  static type: ConnectorType = {
    id: "github",
    name: "GitHub",
    description: "Tu repositorio: la IA puede leer el código, gestionar issues y proponer cambios como Pull Request.",
    permissions: [
      "Metadata: lectura — obligatorio para comprobar el repositorio.",
      "Contents: lectura — para listar y leer archivos.",
      "Contents: lectura y escritura + Pull requests: lectura y escritura — solo si habilitas «Proponer cambios (PR)».",
      "Issues: lectura/escritura — solo para las herramientas de issues.",
      "Limita el token a ESTE repositorio (Only select repositories). Nunca se hace push a la rama principal: los cambios van en una rama nueva con PR.",
    ],
    setup_steps: [
      "GitHub → Settings → Developer settings → Fine-grained personal access tokens → Generate new token.",
      "Repository access: «Only select repositories» y elige el repositorio.",
      "Permissions: Metadata (Read), Contents (Read o Read and write), Pull requests (Read and write), Issues (según uses).",
      "Copia el token y pégalo aquí. Se guarda cifrado y no se vuelve a mostrar.",
    ],
    fields: [
      { name: "repo", label: "Repositorio (propietario/nombre)", placeholder: "mi-usuario/mi-producto", pattern: "[A-Za-z0-9_.\\-]+/[A-Za-z0-9_.\\-]+" },
      { name: "token", label: "Token de acceso", secret: true, placeholder: "github_pat_…", help: "Token fine-grained con acceso solo a ese repositorio." },
    ],
  };

  private headers(extra: Record<string, string> = {}) {
    return {
      Authorization: `Bearer ${this.secrets.token ?? ""}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "control-ia",
      ...extra,
    };
  }

  private check(resp: Response, what = "") {
    if (resp.ok) return;
    const repo = this.config.repo;
    if (resp.status === 401) throw new ConnectorError("GitHub rechazó el token (401): no es válido o caducó.");
    if (resp.status === 403) throw new ConnectorError(`El token no tiene permiso para ${what || "esta operación"} en GitHub (403). Revisa los permisos del token.`);
    if (resp.status === 404) throw new ConnectorError(`No se encontró ${what || repo} o el token no tiene acceso (404).`);
    if (resp.status === 422) throw new ConnectorError(`GitHub rechazó la operación (422) ${what}.`);
    throw new ConnectorError(`GitHub respondió con error ${resp.status}.`);
  }

  private async api(path: string, init: RequestInit = {}, what = ""): Promise<any> {
    const resp = await this.http(`${API}/repos/${this.config.repo}${path}`, {
      ...init,
      headers: this.headers(init.body ? { "Content-Type": "application/json" } : {}),
    });
    this.check(resp, what);
    return resp.status === 204 ? null : resp.json();
  }

  async test() {
    const data = await this.api("");
    return `Acceso verificado a ${data.full_name} (${data.private ? "privado" : "público"}, rama principal «${data.default_branch}»).`;
  }

  async listFiles(prefix = "", limit = 300): Promise<string> {
    const repo = await this.api("");
    const tree = await this.api(`/git/trees/${encodeURIComponent(repo.default_branch)}?recursive=1`, {}, "el árbol de archivos");
    const files = (tree.tree as any[])
      .filter((e) => e.type === "blob" && e.path.startsWith(prefix))
      .map((e) => `${e.path} (${e.size ?? 0} B)`);
    const shown = files.slice(0, limit);
    return shown.join("\n") + (files.length > limit ? `\n… y ${files.length - limit} más (filtra con «prefijo»).` : "") || "(sin archivos)";
  }

  async readFile(path: string): Promise<string> {
    const resp = await this.http(`${API}/repos/${this.config.repo}/contents/${path.split("/").map(encodeURIComponent).join("/")}`, {
      headers: this.headers({ Accept: "application/vnd.github.raw+json" }),
    });
    this.check(resp, `el archivo ${path}`);
    const text = await resp.text();
    return text.length > 60_000 ? text.slice(0, 60_000) + "\n[… archivo truncado a 60.000 caracteres]" : text;
  }

  /** Crea una rama nueva, escribe los archivos y abre un Pull Request. Nunca toca la rama principal. */
  async proposeChanges(title: string, description: string, files: { ruta: string; contenido: string }[]): Promise<string> {
    const repo = await this.api("");
    const base = repo.default_branch as string;
    const ref = await this.api(`/git/ref/heads/${encodeURIComponent(base)}`, {}, "la rama principal");
    const branch = `control-ia/${Date.now().toString(36)}`;
    await this.api("/git/refs", { method: "POST", body: JSON.stringify({ ref: `refs/heads/${branch}`, sha: ref.object.sha }) }, "crear la rama");
    for (const f of files) {
      const path = f.ruta.replace(/^\/+/, "");
      let sha: string | undefined;
      const existing = await this.http(
        `${API}/repos/${this.config.repo}/contents/${path.split("/").map(encodeURIComponent).join("/")}?ref=${encodeURIComponent(branch)}`,
        { headers: this.headers() },
      );
      if (existing.ok) sha = ((await existing.json()) as any).sha;
      await this.api(
        `/contents/${path.split("/").map(encodeURIComponent).join("/")}`,
        { method: "PUT", body: JSON.stringify({ message: `${title}: ${path}`, content: b64Utf8(f.contenido), branch, sha }) },
        `escribir ${path}`,
      );
    }
    const pr = await this.api(
      "/pulls",
      {
        method: "POST",
        body: JSON.stringify({ title, head: branch, base, body: `${description}\n\n---\n_Propuesto desde Control IA; revísalo antes de fusionar._` }),
      },
      "abrir el Pull Request",
    );
    return `Pull Request #${pr.number} abierto: ${pr.html_url} (rama ${branch}, ${files.length} archivo(s)). Revísalo y fusiónalo tú en GitHub.`;
  }

  /** Resultado real de CI (GitHub Actions / checks) de una rama o commit. */
  async ciStatus(ref: string) {
    // Los tokens fine-grained no tienen permiso «Checks»: se usa Actions (Read-only) y, si no, check-runs.
    let list: { name: string; status: string; conclusion: string | null; url: string; summary: string }[];
    try {
      const wr = await this.api(`/actions/runs?branch=${encodeURIComponent(ref)}&per_page=20`, {}, "las ejecuciones de Actions");
      let items = (wr as any).workflow_runs as any[];
      if (!items.length) items = ((await this.api(`/actions/runs?head_sha=${encodeURIComponent(ref)}&per_page=20`, {}, "las ejecuciones de Actions")) as any).workflow_runs;
      const latest = new Map<string, any>();
      for (const r of items) if (!latest.has(r.name)) latest.set(r.name, r); // la más reciente de cada workflow
      list = [...latest.values()].map((r) => ({ name: r.name, status: r.status, conclusion: r.conclusion, url: r.html_url, summary: String(r.display_title ?? "").slice(0, 400) }));
    } catch {
      const runs = await this.api(`/commits/${encodeURIComponent(ref)}/check-runs?per_page=50`, {}, "los checks");
      list = ((runs as any).check_runs as any[]).map((r) => ({ name: r.name, status: r.status, conclusion: r.conclusion, url: r.html_url, summary: String(r.output?.summary ?? "").slice(0, 400) }));
    }
    const pending = list.some((r) => r.status !== "completed");
    const failed = list.filter((r) => r.conclusion && !["success", "skipped", "neutral"].includes(r.conclusion));
    return { total: list.length, pending, failed: failed.length, state: !list.length ? "none" : pending ? "pending" : failed.length ? "failure" : "success", checks: list };
  }

  async listIssues(state = "open", limit = 10) {
    const items = await this.api(`/issues?state=${state}&per_page=${Math.max(1, Math.min(limit, 50))}`, {}, "los issues");
    return (items as any[])
      .filter((i) => !i.pull_request)
      .map((i) => ({ number: i.number, title: i.title, state: i.state, url: i.html_url, body: String(i.body ?? "").slice(0, 1000) }));
  }

  async createIssue(title: string, body: string) {
    const data = await this.api("/issues", { method: "POST", body: JSON.stringify({ title, body }) }, "crear el issue");
    return `Issue #${data.number} creado: ${data.html_url}`;
  }
}
