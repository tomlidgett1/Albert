"""Deterministic local HTTP fixture for the Lightspeed X-Series dlt harness."""

from __future__ import annotations

import json
import threading
from datetime import datetime, timezone
from email.utils import format_datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any, Dict, Mapping, Optional
from urllib.parse import parse_qs, urlparse


FIXTURE_TOKEN = "fixture-access-token"
FIXTURE_PATH = Path(__file__).with_name("fixtures") / "mock_api.json"


class _FixtureHttpServer(ThreadingHTTPServer):
    daemon_threads = True

    def __init__(self, fixture: Mapping[str, Any]) -> None:
        super().__init__(("127.0.0.1", 0), _FixtureHandler)
        self.fixture = fixture
        self.phase = "initial"
        self.retry_sent: set[tuple[str, str]] = set()
        self.requests: list[Dict[str, Any]] = []
        self.request_count = 0


class _FixtureHandler(BaseHTTPRequestHandler):
    server: _FixtureHttpServer

    def log_message(self, _format: str, *_args: object) -> None:
        return

    def do_GET(self) -> None:  # noqa: N802 - BaseHTTPRequestHandler contract
        self._handle("GET")

    def do_POST(self) -> None:  # noqa: N802 - BaseHTTPRequestHandler contract
        self._handle("POST")

    def _handle(self, method: str) -> None:
        parsed = urlparse(self.path)
        query = {key: values[-1] for key, values in parse_qs(parsed.query).items()}
        body: Dict[str, Any] = {}
        if method == "POST":
            length = int(self.headers.get("Content-Length", "0"))
            try:
                body = json.loads(self.rfile.read(length) or b"{}")
            except (json.JSONDecodeError, UnicodeDecodeError):
                self._send(400, {"error": "invalid JSON"}, method, parsed.path, query, {})
                return

        if self.headers.get("Authorization") != f"Bearer {FIXTURE_TOKEN}":
            self._send(401, {"error": "fixture bearer token required"}, method, parsed.path, query, body)
            return

        prefix = "/api/2026-07"
        if not parsed.path.startswith(prefix):
            self._send(404, {"error": "wrong API version"}, method, parsed.path, query, body)
            return
        endpoint = parsed.path[len(prefix) :] or "/"
        phase = self.server.fixture["phases"][self.server.phase]

        if method == "GET" and endpoint == "/sales":
            after = query.get("after", "0")
            retry_key = (self.server.phase, after)
            retry_after = set(phase["sales"].get("retry_once_after", []))
            if after in retry_after and retry_key not in self.server.retry_sent:
                self.server.retry_sent.add(retry_key)
                self._send(
                    429,
                    {"error": "fixture rate window exhausted"},
                    method,
                    parsed.path,
                    query,
                    body,
                    {"Retry-After": format_datetime(datetime.now(timezone.utc), usegmt=True)},
                )
                return
            payload = phase["sales"]["pages"].get(after)
        elif method == "POST" and endpoint == "/inventory":
            if body.get("include_deleted") is not True or body.get("sort_direction") != "asc":
                self._send(400, {"error": "inventory scan must include tombstones and sort ascending"}, method, parsed.path, query, body)
                return
            payload = phase["inventory"]["pages"].get(str(body.get("after", 0)))
        elif method == "POST" and endpoint == "/inventory_levels":
            payload = phase["inventory_levels"]["pages"].get(str(body.get("offset", 0)))
        elif method == "GET" and endpoint == "/fulfillments":
            payload = phase["fulfillments"]["pages"].get(query.get("page_number", "1"))
        elif method == "GET" and endpoint == "/product_categories":
            payload = phase["product_categories"]["pages"].get(query.get("after", "__start__"))
        elif method == "GET" and endpoint == "/quotes":
            payload = phase["quotes"]["pages"].get(query.get("after", "0"))
        elif method == "GET" and endpoint == "/fulfillments/fulfill-1/history":
            payload = phase["fulfillment_history"]["pages"].get(query.get("cursor", "__start__"))
        else:
            payload = None

        if payload is None:
            self._send(400, {"error": "unexpected or non-advancing fixture cursor"}, method, parsed.path, query, body)
            return
        self._send(200, payload, method, parsed.path, query, body)

    def _send(
        self,
        status: int,
        payload: object,
        method: str,
        path: str,
        query: Mapping[str, str],
        body: Mapping[str, Any],
        extra_headers: Optional[Mapping[str, str]] = None,
    ) -> None:
        self.server.request_count += 1
        remaining = max(0, 350 - self.server.request_count)
        encoded = json.dumps(payload, separators=(",", ":")).encode("utf-8")
        self.server.requests.append(
            {"method": method, "path": path, "query": dict(query), "body": dict(body), "status": status}
        )
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(encoded)))
        self.send_header("X-RateLimit-Limit", "350")
        self.send_header("X-RateLimit-Remaining", str(remaining))
        for key, value in (extra_headers or {}).items():
            self.send_header(key, value)
        self.end_headers()
        self.wfile.write(encoded)


class FixtureApiServer:
    """Context-managed local server whose phase can switch between dlt runs."""

    def __init__(self, fixture_path: Path = FIXTURE_PATH) -> None:
        self.fixture = json.loads(fixture_path.read_text(encoding="utf-8"))
        self._server: Optional[_FixtureHttpServer] = None
        self._thread: Optional[threading.Thread] = None

    def __enter__(self) -> "FixtureApiServer":
        self._server = _FixtureHttpServer(self.fixture)
        self._thread = threading.Thread(target=self._server.serve_forever, name="lightspeed-x-fixture", daemon=True)
        self._thread.start()
        return self

    def __exit__(self, *_exc: object) -> None:
        if self._server is not None:
            self._server.shutdown()
            self._server.server_close()
        if self._thread is not None:
            self._thread.join(timeout=5)

    @property
    def base_url(self) -> str:
        if self._server is None:
            raise RuntimeError("fixture server is not running")
        host, port = self._server.server_address
        return f"http://{host}:{port}/api/2026-07/"

    @property
    def requests(self) -> list[Dict[str, Any]]:
        if self._server is None:
            return []
        return list(self._server.requests)

    def set_phase(self, phase: str) -> None:
        if self._server is None:
            raise RuntimeError("fixture server is not running")
        if phase not in self.fixture["phases"]:
            raise ValueError(f"unknown fixture phase: {phase}")
        self._server.phase = phase

