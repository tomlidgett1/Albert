"""
A grant refreshed by someone else (a partner's token broker, ADR 0151) rotates
the access token under a long walk. Lightspeed then answers 403 "Access token
has been revoked", not 401: the client must fetch the current token and retry
instead of recording the walk as unavailable. A plain 403 (no permission)
still means unavailable.

Run: python3 -m unittest discover -s connectors/lightspeed-fivetran-sdk/tests -v
"""
from __future__ import annotations

import json
import os
import sys
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))

from lightspeed_client import LightspeedClient, NotAvailable, RateGovernor, TokenSupply  # noqa: E402

CURRENT_TOKEN = {"value": "new-token"}


class RotatingSupply(TokenSupply):
    """Hands out the stale token first; a forced fetch returns the current one."""

    def __init__(self):
        super().__init__({"lightspeed_access_token": "unused", "lightspeed_account_id": "12345"})
        self.static_token = None
        self.fetches: list[bool] = []
        self._served_stale = False

    def token(self, force: bool = False) -> str:
        self.fetches.append(force)
        if force or self._served_stale:
            return CURRENT_TOKEN["value"]
        self._served_stale = True
        return "stale-token"


class Mock(BaseHTTPRequestHandler):
    revoked_message = "Access token has been revoked"

    def log_message(self, *args):  # noqa: D401 - silence the test server
        return

    def do_GET(self):  # noqa: N802 - http.server API
        token = self.headers.get("authorization", "").removeprefix("Bearer ")
        if self.path.startswith("/API/V3/Account/12345/Forbidden.json"):
            self._send(403, {"httpCode": "403", "message": "You do not have permission to access this resource."})
        elif token != CURRENT_TOKEN["value"]:
            self._send(403, {"httpCode": "403", "httpMessage": "Forbidden", "message": Mock.revoked_message})
        else:
            self._send(200, {"@attributes": {"count": "0"}})

    def _send(self, status: int, body: dict):
        payload = json.dumps(body).encode("utf-8")
        self.send_response(status)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)


class TokenRevokedTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = ThreadingHTTPServer(("127.0.0.1", 0), Mock)
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()
        cls.origin = f"http://127.0.0.1:{cls.server.server_address[1]}"

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()

    def client(self, supply: TokenSupply) -> LightspeedClient:
        return LightspeedClient({}, supply, origin=self.origin, governor=RateGovernor(), sleep=lambda _: None)

    def test_revoked_token_is_refetched_and_retried(self):
        supply = RotatingSupply()
        status, body = self.client(supply).get_json("Sale.json")
        self.assertEqual(status, 200)
        self.assertEqual(body, {"@attributes": {"count": "0"}})
        self.assertEqual(supply.fetches, [False, True])

    def test_permission_403_is_still_unavailable(self):
        supply = RotatingSupply()
        supply._served_stale = True
        with self.assertRaises(NotAvailable):
            self.client(supply).get_json("Forbidden.json")
        self.assertEqual(supply.fetches, [False])


if __name__ == "__main__":
    unittest.main()
