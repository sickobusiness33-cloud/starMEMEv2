"""Conector GitHub: un repositorio concreto con un token de acceso fino."""

from __future__ import annotations

from typing import Any

from .base import Connector, ConnectorError, ConnectorType, FieldSpec

API = "https://api.github.com"


class GitHubConnector(Connector):
    type = ConnectorType(
        id="github",
        name="GitHub",
        description="Lee y crea issues en un único repositorio.",
        permissions=[
            "Metadata: lectura — obligatorio para comprobar que el repositorio existe.",
            "Issues: lectura — para la herramienta «Listar issues».",
            "Issues: lectura y escritura — solo si habilitas «Crear issue».",
            "Limita el token a este único repositorio (Repository access → Only select repositories).",
        ],
        setup_steps=[
            "GitHub → Settings → Developer settings → Fine-grained personal access tokens → "
            "Generate new token.",
            "Repository access: «Only select repositories» y elige el repositorio.",
            "Permissions → Repository: Metadata (Read) e Issues (Read, o Read and write si vas a "
            "crear issues).",
            "Copia el token y pégalo aquí. Se guarda cifrado en el servidor y no se vuelve a mostrar.",
        ],
        fields=[
            FieldSpec(
                "repo",
                "Repositorio (propietario/nombre)",
                placeholder="mi-org/mi-repo",
                pattern=r"[A-Za-z0-9_.\-]+/[A-Za-z0-9_.\-]+",
            ),
            FieldSpec(
                "token",
                "Token de acceso",
                secret=True,
                placeholder="github_pat_…",
                help="Token fine-grained con acceso solo a ese repositorio.",
            ),
        ],
    )

    def _headers(self) -> dict[str, str]:
        return {
            "Authorization": f"Bearer {self.secrets.get('token', '')}",
            "Accept": "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
            "User-Agent": "control-ia",
        }

    def _check(self, resp) -> None:
        if resp.status_code == 401:
            raise ConnectorError("GitHub rechazó el token (401): no es válido o caducó.")
        if resp.status_code == 403:
            raise ConnectorError("El token no tiene permiso para esta operación en GitHub (403).")
        if resp.status_code == 404:
            raise ConnectorError(
                f"No se encontró {self.config.get('repo')} o el token no tiene acceso a él (404)."
            )
        if resp.status_code >= 400:
            raise ConnectorError(f"GitHub respondió con error {resp.status_code}.")

    async def test(self) -> str:
        repo = self.config["repo"]
        resp = await self._http("GET", f"{API}/repos/{repo}", headers=self._headers())
        self._check(resp)
        data = resp.json()
        visibility = "privado" if data.get("private") else "público"
        return f"Acceso verificado a {data.get('full_name', repo)} (repositorio {visibility})."

    async def list_issues(self, state: str = "open", limit: int = 10) -> list[dict[str, Any]]:
        resp = await self._http(
            "GET",
            f"{API}/repos/{self.config['repo']}/issues",
            headers=self._headers(),
            params={"state": state, "per_page": max(1, min(limit, 50))},
        )
        self._check(resp)
        return [
            {
                "number": i["number"],
                "title": i["title"],
                "state": i["state"],
                "url": i["html_url"],
                "body": (i.get("body") or "")[:1000],
            }
            for i in resp.json()
            if "pull_request" not in i
        ]

    async def create_issue(self, title: str, body: str) -> dict[str, Any]:
        resp = await self._http(
            "POST",
            f"{API}/repos/{self.config['repo']}/issues",
            headers=self._headers(),
            json={"title": title, "body": body},
        )
        self._check(resp)
        data = resp.json()
        return {"number": data["number"], "url": data["html_url"]}
