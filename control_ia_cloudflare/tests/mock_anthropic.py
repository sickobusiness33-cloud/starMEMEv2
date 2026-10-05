"""Servidor mínimo que imita la API de mensajes de Anthropic para los tests locales.

POST /__mode {"mode": "ok" | "credit"} cambia el comportamiento:
  ok     → responde un mensaje válido
  credit → 400 "Your credit balance is too low" (como la API real sin créditos)
"""

import json
from http.server import BaseHTTPRequestHandler, HTTPServer

STATE = {"mode": "ok", "calls": 0, "ext": []}

COIN = {
    "name": "Gemini Gato", "ticker": "GMGT", "theme": "gatos en la nube", "mascot": "Nimbo", "tagline": "El gato que vive en la nube",
    "description": "Una meme coin conceptual sobre un gato que vive en una nube y responde en verso.",
    "lore": "Nimbo era un gato normal hasta que una tormenta lo subió a una nube. Desde allí observa el mundo, escribe poemas malísimos y los lanza en forma de lluvia. La comunidad recoge cada gota y la convierte en meme. Nadie sabe si Nimbo bajará algún día, pero todos esperan su próximo verso con paciencia y humor.",
    "traits": ["Poeta", "Esponjoso", "Paciente"], "slogans": ["Llueven versos", "Miau desde arriba"], "style": "pastel", "chain": "Base",
    "tokenomics": {"supply": "1.000.000.000", "distribution": [{"label": "Liquidez", "pct": 70}, {"label": "Comunidad", "pct": 30}]},
    "roadmap": [{"phase": "Nube 1", "text": "Nace Nimbo."}], "community": ["Verso del día"], "logo_prompt": "fluffy cat on a cloud",
    "ai": {"label": "Habla con Nimbo", "placeholder": "Pídele un verso", "examples": ["Un verso"], "system": "Eres Nimbo, un gato poeta que vive en una nube y habla en verso."},
    "faq": [{"q": "¿Se compra?", "a": "No, es un concepto."}],
    "seo": {"title": "Gemini Gato · meme coin conceptual", "description": "Conoce a Nimbo, el gato poeta que vive en una nube: historia, tokenomics y comunidad de esta meme coin."},
}


def ext_reply(system, user):
    if "[factory:coins]" in system:
        import re
        n = int((re.search(r"Propón (\d+) meme coins", user) or [0, 1])[1])
        STATE["seq"] = STATE.get("seq", 0) + n
        base = STATE["seq"]
        return json.dumps({"coins": [{"name": f"Gemini Gato {base + i}", "ticker": f"GM{base + i}X", "idea": "Un gato que vive en una nube y responde siempre en verso."} for i in range(n)]})
    if "[factory:coin]" in system:
        return json.dumps(COIN)
    return f"[ext mock] {user[:200]}"


class H(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def _send(self, code, body):
        data = json.dumps(body).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        if self.path.endswith("/models"):
            return self._send(200, {"object": "list", "data": [{"id": "gemini-2.5-flash"}, {"id": "llama-3.3-70b-versatile"}]})
        self._send(200, STATE)

    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers.get("Content-Length") or 0)) or b"{}")
        if self.path == "/__mode":
            STATE["mode"] = body.get("mode", "ok")
            STATE["calls"] = 0
            STATE["ext"] = []
            return self._send(200, STATE)
        if self.path.endswith("/chat/completions"):
            vendor = self.path.strip("/").split("/")[0]
            STATE["ext"].append({"vendor": vendor, "model": body.get("model"), "auth": self.headers.get("Authorization", "")[:12]})
            if STATE["mode"] == "ext-quota" and vendor == "gemini":
                return self._send(429, [{"error": {"code": 429, "message": "You exceeded your current quota", "status": "RESOURCE_EXHAUSTED"}}])
            msgs = body.get("messages", [])
            system = next((m["content"] for m in msgs if m["role"] == "system"), "")
            user = msgs[-1]["content"] if msgs else ""
            text = ext_reply(system, user if isinstance(user, str) else json.dumps(user))
            return self._send(200, {"id": "chatcmpl-mock", "object": "chat.completion", "model": body.get("model"),
                                    "choices": [{"index": 0, "message": {"role": "assistant", "content": text}, "finish_reason": "stop"}],
                                    "usage": {"prompt_tokens": 20, "completion_tokens": 40}})
        STATE["calls"] += 1
        if STATE["mode"] == "credit":
            return self._send(400, {"type": "error", "error": {"type": "invalid_request_error", "message": "Your credit balance is too low to access the Anthropic API."}})
        last = body["messages"][-1]["content"]
        text = last if isinstance(last, str) else json.dumps(last)
        return self._send(200, {
            "id": "msg_mock", "type": "message", "role": "assistant", "model": body["model"],
            "content": [{"type": "text", "text": f"[claude mock {body['model']}] {text[:300]}"}],
            "stop_reason": "end_turn", "stop_sequence": None, "usage": {"input_tokens": 12, "output_tokens": 8},
        })


if __name__ == "__main__":
    HTTPServer(("127.0.0.1", 8799), H).serve_forever()
