"""Standalone mock R-Series for `fivetran debug`: python3 tests/mock_lightspeed_server.py [port]."""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from http.server import ThreadingHTTPServer  # noqa: E402

from test_sync_e2e import MockLightspeed  # noqa: E402

if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8766
    server = ThreadingHTTPServer(("127.0.0.1", port), MockLightspeed)
    print(f"mock lightspeed on http://127.0.0.1:{port}", flush=True)
    server.serve_forever()
