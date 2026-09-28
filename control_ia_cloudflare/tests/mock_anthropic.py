"""Servidor mínimo que imita la API de mensajes de Anthropic para los tests locales.

POST /__mode {"mode": "ok" | "credit"} cambia el comportamiento:
  ok     → responde un mensaje válido
  credit → 400 "Your credit balance is too low" (como la API real sin créditos)
"""

import json
from http.server import BaseHTTPRequestHandler, HTTPServer

STATE = {"mode": "ok", "calls": 0}


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
        self._send(200, STATE)

    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers.get("Content-Length") or 0)) or b"{}")
        if self.path == "/__mode":
            STATE["mode"] = body.get("mode", "ok")
            STATE["calls"] = 0
            return self._send(200, STATE)
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
