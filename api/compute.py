"""Authenticated server-to-server Python function; also runs locally on loopback."""
import hashlib
import hmac
import json
import os
from http.server import BaseHTTPRequestHandler

from compute.registry import ComputeError, run

MAX_BODY = 64000


def process(method, authorization, content_type, raw):
    if method != "POST":
        return 405, {"error": {"code": "method", "message": "Method not allowed."}}
    token = os.environ.get("COMPUTE_SERVICE_TOKEN", "")
    if not token or token != token.strip() or len(token) < 32 or any(ord(c) < 33 or ord(c) > 126 for c in token):
        return 503, {"error": {"code": "configuration", "message": "Compute service is not configured."}}
    if not hmac.compare_digest(hashlib.sha256(authorization.encode()).digest(), hashlib.sha256(("Bearer " + token).encode()).digest()):
        return 401, {"error": {"code": "authentication", "message": "Compute access rejected."}}
    if content_type.split(";", 1)[0].strip().lower() != "application/json" or len(raw) > MAX_BODY:
        return 400, {"error": {"code": "validation", "message": "Send a bounded JSON calculation request."}}
    try:
        result = run(json.loads(raw))
        if len(json.dumps(result).encode()) > MAX_BODY:
            raise ComputeError("limit", "Calculation output is too large.")
        return 200, result
    except ComputeError as error:
        return (408 if error.code == "timeout" else 400), {"error": {"code": error.code, "message": error.message}}
    except (ValueError, TypeError, UnicodeError):
        return 400, {"error": {"code": "validation", "message": "Invalid calculation request."}}
    except Exception:
        return 500, {"error": {"code": "calculation", "message": "Calculation failed."}}


class handler(BaseHTTPRequestHandler):
    def respond(self):
        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            length = -1
        if length < 0 or length > MAX_BODY:
            status, body = 413, {"error": {"code": "limit", "message": "Calculation request is too large."}}
        else:
            status, body = process(self.command, self.headers.get("Authorization", ""),
                                   self.headers.get("Content-Type", ""), self.rfile.read(length))
        encoded = json.dumps(body, allow_nan=False).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(encoded)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        if status == 405:
            self.send_header("Allow", "POST")
        self.end_headers()
        self.wfile.write(encoded)

    do_POST = respond
    do_GET = respond
    do_PUT = respond
    do_DELETE = respond
    do_OPTIONS = respond

    def log_message(self, format, *args):
        pass  # No request content, user data or credentials in HTTP logs.


if __name__ == "__main__":
    from http.server import ThreadingHTTPServer
    print("Compute service listening on http://127.0.0.1:3001/api/compute", flush=True)
    ThreadingHTTPServer(("127.0.0.1", 3001), handler).serve_forever()
