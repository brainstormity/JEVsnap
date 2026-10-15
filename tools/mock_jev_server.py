#!/usr/bin/env python3
"""Tiny local stand-in for the TypeSafe System One API, for offline testing.

    python3 scripts/mock_jev_server.py 8765 &
    JEVSNAP_TEST_SERVER=http://127.0.0.1:8765 swift test --filter LiveTransportTests

It enforces the same rules the real API documents (bearer auth, images header for
Box/assets, every asset referenced) and answers "yes" for any line containing "Jane".
The first systemone request is answered with a 429 to exercise the client's retry path.
"""
import json
import sys
from http.server import BaseHTTPRequestHandler, HTTPServer

KEY = "testkey"
state = {"calls": 0}


class Handler(BaseHTTPRequestHandler):
    def _send(self, code, payload, headers=None):
        body = json.dumps(payload).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        for k, v in (headers or {}).items():
            self.send_header(k, v)
        self.end_headers()
        self.wfile.write(body)

    def _authed(self):
        return self.headers.get("Authorization") == f"Bearer {KEY}"

    def do_GET(self):
        if not self._authed():
            return self._send(401, {"error": {"message": "invalid api key"}})
        if self.path == "/v1/models":
            return self._send(200, {"models": [
                {"name": "jev-latest", "description": "stable", "release_date": "2026-10-02"},
                {"name": "jev-preview", "description": "preview", "release_date": "2026-10-14"}]})
        self._send(404, {"error": {"message": "not found"}})

    def do_POST(self):
        if self.path != "/v1/systemone":
            return self._send(404, {"error": {"message": "not found"}})
        if not self._authed():
            return self._send(401, {"error": {"message": "invalid api key"}})
        length = int(self.headers.get("Content-Length", 0))
        req = json.loads(self.rfile.read(length))
        state["calls"] += 1
        if state["calls"] == 1:
            return self._send(429, {"error": {"message": "slow down"}}, {"Retry-After": "0"})

        questions = req.get("questions", {})
        uses_images = bool(req.get("assets")) or any(q.get("type") == "box" for q in questions.values())
        if uses_images and self.headers.get("TypeSafe-Danger-Zone-Images") != "true":
            return self._send(400, {"error": {"message": "images are not turned on"}})
        for q in questions.values():
            if q.get("type") not in ("noul", "choice", "score", "box") or "instructions" not in q:
                return self._send(422, {"error": {"message": "malformed question"}})

        screen = (req.get("state") or {}).get("screen", {})
        words = (req.get("state") or {}).get("words", {})
        answers = {}
        for qid, q in questions.items():
            if q["type"] == "noul":
                text = screen.get(qid, "")
                word = words.get(qid, {}).get("text")
                sensitive = word in ("Jane", "Doe", "Andy") if word is not None else ("Jane" in text or "Andy" in text)
                answers[qid] = {"type": "noul", "noul": 0.95 if sensitive else 0.04}
            elif q["type"] == "box":
                answers[qid] = {"type": "box", "box": {"top": 0.1, "bottom": 0.3, "left": 0.2, "right": 0.4}, "confidence": 0.9}
        self._send(200, {"model": "jev-1.14.0", "answers": answers, "usage": {"input_tokens": 100, "output_tokens": 5}})

    def log_message(self, *args):
        pass


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8765
    HTTPServer(("127.0.0.1", port), Handler).serve_forever()
