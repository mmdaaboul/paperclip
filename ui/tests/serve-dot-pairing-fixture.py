"""Loopback-only compiled UI fixture. Never connects to a real Paperclip instance.

Request suffix A: valid preview; B: expired; C: one preview outage then recovery.
All non-Dot API requests fail and are logged without headers or request bodies.
"""
import argparse
import json
import mimetypes
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlsplit

parser = argparse.ArgumentParser()
parser.add_argument("--root", type=Path, required=True)
parser.add_argument("--log", type=Path, required=True)
args = parser.parse_args()
root = args.root.resolve()
lock = threading.Lock()
events = []
outage = {"preview_failed": False, "probe_failed": False}


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *_args):
        pass

    def reply(self, status, body, content_type="application/json"):
        if not isinstance(body, bytes):
            body = json.dumps(body).encode()
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)
        with lock:
            events.append({"method": self.command, "path": self.path, "status": status})
            args.log.write_text(json.dumps(events, indent=2) + "\n")

    def do_GET(self):
        path = urlsplit(self.path).path
        if path == "/__fixture/requests":
            return self.reply(200, events)
        if path.startswith("/api/dot-mcp/requests/pcmcp_request_"):
            request_id = path.rsplit("/", 1)[-1]
            if request_id == "pcmcp_request_" + "B" * 43:
                return self.reply(404, {"error": "invalid_request", "error_description": "Fixture request expired"})
            if request_id == "pcmcp_request_" + "C" * 43 and outage["preview_failed"] and not outage["probe_failed"]:
                outage["probe_failed"] = True
                return self.reply(503, {"error": "tenant_app_unavailable"})
            return self.reply(200, {"id": request_id, "agentConnection": True,
                "clientName": "Local fixture assistant", "clientOrigin": None,
                "redirectOrigin": "https://assistant.example.test", "requiresSignIn": True,
                "requestedWrite": False, "requestedConfigure": False, "offlineAccess": True,
                "requestedCompanyId": None, "companies": [], "setupUrl": None})
        if path.startswith("/api/"):
            return self.reply(503, {"error": "tenant_app_unavailable"})
        if path == "/auth":
            return self.reply(200, b"<!doctype html><title>Fixture board document</title><h1>Fixture board document</h1>", "text/html")
        file = root / "tests/dot-pairing.html" if path.startswith("/dot-connect/") else root / path.lstrip("/")
        file = file.resolve()
        if not file.is_relative_to(root) or not file.is_file():
            return self.reply(404, {"error": "not_found"})
        return self.reply(200, file.read_bytes(), mimetypes.guess_type(str(file))[0] or "application/octet-stream")

    def do_POST(self):
        size = int(self.headers.get("Content-Length", "0"))
        if size > 16384:
            return self.reply(413, {"error": "invalid_request"})
        self.rfile.read(size)  # fixture-only value, deliberately not logged
        path = urlsplit(self.path).path
        if path.startswith("/api/dot-mcp/requests/") and path.endswith("/dot-pairing/preview"):
            if "/pcmcp_request_" + "C" * 43 + "/" in path and not outage["preview_failed"]:
                outage["preview_failed"] = True
                return self.reply(503, {"error": "tenant_app_unavailable"})
            return self.reply(200, {"company": {"id": "fixture-company", "name": "Local fixture company"},
                "agent": {"id": "fixture-agent", "name": "Local fixture reviewer"},
                "permissions": "Local fixture agent permissions", "accessDuration": "Fixture only",
                "pairingExpiresAt": "2099-01-01T00:00:00.000Z"})
        # No approval/grant implementation exists in this fixture.
        return self.reply(403, {"error": "access_denied"})


server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
args.log.parent.mkdir(parents=True, exist_ok=True)
print(json.dumps({"url": "http://127.0.0.1:" + str(server.server_port), "fixtureOnly": True}), flush=True)
try:
    server.serve_forever()
except KeyboardInterrupt:
    pass
finally:
    server.server_close()
