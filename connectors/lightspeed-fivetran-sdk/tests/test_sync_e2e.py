"""
End-to-end against a mock R-Series built from the walk pages the generator
assembled from the sanitized recording: every group walk and fan-out
sub-request is served from the fixture, so the full walk (id sort, `after`
continuation, extra passes, modified/id/date windows, relation guard, typed
emit, checkpoints, resume) runs exactly as it would against Lightspeed.

Run: python3 -m unittest discover -s connectors/lightspeed-fivetran-sdk/tests -v
"""
from __future__ import annotations

import json
import os
import re
import sys
import threading
import unittest
from datetime import date, datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))

import lightspeed_client  # noqa: E402
from lightspeed_client import LightspeedClient, RateGovernor, TokenSupply  # noqa: E402
from lightspeed_spec import SPEC  # noqa: E402
from lightspeed_sync import CONTRACT_TABLE, LightspeedSync, row_to_record, spec_schema  # noqa: E402


def _load(name: str):
    with open(os.path.join(HERE, name), encoding="utf-8") as handle:
        return json.load(handle)


PAGES = _load("walk_pages.json")
TABLES = SPEC["tables"]
ACCOUNT_PREFIX = "/API/V3/Account/12345/"

# Group walk path → page; fan-out template → regex.
EXACT: dict[str, dict] = {}
for group in SPEC["groups"]:
    page = PAGES.get(group["resource"])
    if page is not None:
        EXACT[ACCOUNT_PREFIX + group["path"]] = page
PATTERNS: list[tuple[re.Pattern, dict, dict]] = []
for fan_out in SPEC["fanOuts"]:
    pattern = re.compile("^" + re.escape(ACCOUNT_PREFIX) + re.sub(r"\\\{[A-Za-z]+\\\}", "[^/]+", re.escape(fan_out["endpointTemplate"])) + "$")
    body = {"@attributes": {"count": "1"}, fan_out["resource"]: [{"paymentTypeID": "3", "payment": "10.0000",
                                                                    "workorderImageID": "77", "customFieldChoiceID": "5",
                                                                    "timeStamp": "2026-08-01T00:00:00+00:00"}]}
    PATTERNS.append((pattern, fan_out, body))


class MockLightspeed(BaseHTTPRequestHandler):
    calls: list = []
    # Resource → number of pages to serve before the terminal one.
    paginate: dict = {}
    # When set, every request answers 401 (a dead token).
    token_dead = False
    # Resources answering 404 (plan-gated endpoints).
    absent: set = set()
    # Resource whose nested relation is stripped from every record (silent drop).
    strip_relation: tuple | None = None
    # 429 once for these resources.
    throttle_once: set = set()
    # Close the connection without any response, once, for these resources
    # (the client sees http.client.RemoteDisconnected).
    drop_once: set = set()
    # Resource -> relation the vendor refuses with a 400 (ItemFee.ItemFeeCategories live).
    refuse_relation: dict = {}
    # Resource -> relation silently dropped whenever more than N relations are requested.
    drop_when_many: dict = {}

    def log_message(self, *_args):  # quiet
        return

    def _reply(self, status: int, body, headers: dict | None = None):
        payload = json.dumps(body).encode("utf-8")
        self.send_response(status)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(payload)))
        self.send_header("X-LS-API-Bucket-Level", "3/60")
        self.send_header("X-LS-API-Drip-Rate", "1")
        for key, value in (headers or {}).items():
            self.send_header(key, value)
        self.end_headers()
        self.wfile.write(payload)

    def do_GET(self):  # noqa: N802
        parsed = urlparse(self.path)
        path = parsed.path
        params = parse_qs(parsed.query)
        MockLightspeed.calls.append((path, params, {k.lower(): v for k, v in self.headers.items()}))
        if MockLightspeed.token_dead:
            return self._reply(401, {"httpCode": "401", "message": "Invalid access token"})
        if path == "/API/V3/Account.json":
            body = json.loads(json.dumps(EXACT.get(ACCOUNT_PREFIX + "Account.json") or {"@attributes": {"count": "1"}, "Account": {"accountID": "12345", "name": "Mock Bikes"}}))
            return self._reply(200, body)
        resource = path[len(ACCOUNT_PREFIX):].removesuffix(".json") if path.startswith(ACCOUNT_PREFIX) else ""
        if resource in MockLightspeed.drop_once:
            MockLightspeed.drop_once.discard(resource)
            self.close_connection = True
            self.connection.close()
            return
        if resource in MockLightspeed.absent:
            return self._reply(404, {"httpCode": "404", "message": "Endpoint not found"})
        if resource in MockLightspeed.throttle_once:
            MockLightspeed.throttle_once.discard(resource)
            return self._reply(429, {"httpCode": "429", "message": "Rate limit exceeded"}, {"Retry-After": "0.01"})
        requested = json.loads(params.get("load_relations", ["[]"])[0]) if params.get("load_relations") else []
        refused = MockLightspeed.refuse_relation.get(resource)
        if refused and refused in requested:
            return self._reply(400, {"httpCode": "400", "httpMessage": "Bad Request",
                                     "message": f"Tried to load one or more relations that are not allowed: {refused}"})
        body = EXACT.get(path)
        if body is None:
            for pattern, _fan_out, candidate in PATTERNS:
                if pattern.match(path):
                    body = candidate
                    break
        if body is None:
            return self._reply(404, {"httpCode": "404", "message": "not found"})
        body = json.loads(json.dumps(body))
        if MockLightspeed.strip_relation and MockLightspeed.strip_relation[0] == resource:
            for record in body.get(resource) or []:
                record.pop(MockLightspeed.strip_relation[1], None)
        silent = MockLightspeed.drop_when_many.get(resource)
        if silent and len(requested) > silent[1]:
            for record in body.get(resource) or []:
                record.pop(silent[0], None)
        pages = MockLightspeed.paginate.get(resource, 0)
        after = params.get("after", [None])[0]
        page_no = int(after.split("-")[-1]) if after else 0
        if page_no < pages:
            body["@attributes"]["next"] = f"https://api.lightspeedapp.com{path}?after=cursor-{page_no + 1}"
        return self._reply(200, body)


class SyncEndToEnd(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = ThreadingHTTPServer(("127.0.0.1", 0), MockLightspeed)
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()
        cls.origin = f"http://127.0.0.1:{cls.server.server_address[1]}"

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()

    def _client(self):
        configuration = {"lightspeed_access_token": "debug-token", "lightspeed_account_id": "12345"}
        client = LightspeedClient(configuration, TokenSupply(configuration), origin=self.origin,
                                  governor=RateGovernor(capacity=1000, drip_rate=1000), sleep=lambda _s: None)
        return configuration, client

    def _run(self, configuration, client, state=None, now=None, emitted=None, checkpoints=None):
        emitted = {} if emitted is None else emitted
        sync = LightspeedSync(configuration, json.loads(json.dumps(state or {})),
                              lambda t, r: emitted.setdefault(t, []).append(r),
                              (lambda s: checkpoints.append(json.loads(json.dumps(s, default=str)))) if checkpoints is not None else (lambda s: None),
                              client=client, now=now or datetime(2026, 8, 17, tzinfo=timezone.utc))
        return sync, sync.run(), emitted

    def test_full_walk_then_incremental_windows(self):
        MockLightspeed.calls = []
        configuration, client = self._client()
        checkpoints: list = []
        sync, summary, emitted = self._run(configuration, client, checkpoints=checkpoints)
        self.assertGreater(summary["rows"], 60)
        self.assertEqual(summary["errors"], 0)
        # Leader + nested members from ONE Sale walk.
        sale_calls = [c for c in MockLightspeed.calls if c[0].endswith("/Sale.json")]
        self.assertEqual(len(sale_calls), 1)
        self.assertEqual(sale_calls[0][1]["sort"], ["saleID"])
        self.assertEqual(sale_calls[0][1]["limit"], ["100"])
        # Only relations the projection reads: member roots (Sale.Customer is
        # an enrichment the worker loads but no staged column can see).
        self.assertEqual(json.loads(sale_calls[0][1]["load_relations"][0]),
                         ["SaleLines.InventorySales", "SalePayments.SaleAccounts", "SalePayments.Signatures"])
        self.assertNotIn("timeStamp", sale_calls[0][1])
        for table in ("ls_sales", "ls_sale_lines", "ls_sale_payments", "ls_sale_accounts", "ls_account"):
            self.assertIn(table, emitted, table)
        # Account.json is fetched above the account path, never under it, and
        # takes no paging/sort/relations.
        account_calls = [c for c in MockLightspeed.calls if c[0] == "/API/V3/Account.json"]
        self.assertTrue(account_calls)
        self.assertEqual([c for c in account_calls if c[1]], [], "Account.json must be requested bare")
        self.assertFalse(any(c[0] == ACCOUNT_PREFIX + "Account.json" for c in MockLightspeed.calls))
        sale = emitted["ls_sales"][0]
        self.assertEqual(sale["source_record_id"], "601")
        self.assertEqual(sale["sale_id"], "601.0000")
        self.assertIs(sale["completed"], True)
        self.assertEqual(sale["calc_total"], "1499.0000")
        self.assertEqual(sale["complete_time"], datetime(2026, 7, 31, 6, 15, tzinfo=timezone.utc))
        self.assertEqual(sale["source_updated_at"], datetime(2026, 7, 31, 6, 16, tzinfo=timezone.utc))
        self.assertIs(sale["tombstone"], False)
        line = emitted["ls_sale_lines"][0]
        self.assertEqual(line["sale_id"], sale["sale_id"])
        # Parent context projected onto the child (0125 columns).
        self.assertIs(line["completed"], True)
        self.assertEqual(line["shop_id"], "101.0000")
        # Hidden populations walked as extra passes of the same walk.
        item_calls = [c for c in MockLightspeed.calls if c[0].endswith("/Item.json")]
        self.assertEqual([c[1].get("archived") for c in item_calls], [None, ["only"]])
        # The supplier catalogue mirror is never walked.
        self.assertNotIn("ls_catalog_vendor_items", emitted)
        self.assertFalse(any(c[0].endswith("/CatalogVendorItem.json") for c in MockLightspeed.calls))
        self.assertTrue(sync.state["groups"]["CatalogVendorItem"]["skipped"])
        # Contacts projected from every walk that carries them.
        self.assertGreaterEqual(len(emitted["ls_contacts"]), 2)
        # Register calculated fan-out (always on) ran; workorder images (opt-in) did not.
        self.assertIn("ls_register_calculated", emitted)
        self.assertNotIn("ls_workorder_images", emitted)
        # The column contract landed once.
        self.assertIn(CONTRACT_TABLE, emitted)
        self.assertTrue(any(r["table_name"] == "ls_sales" and r["column_name"] == "tax1_rate" for r in emitted[CONTRACT_TABLE]))
        # Every walked group checkpointed a completion, none left a cursor.
        for key, entry in sync.state["groups"].items():
            self.assertNotIn("cursor", entry, key)
            self.assertTrue("completed_at" in entry or "unavailable" in entry or entry.get("skipped"), key)
        self.assertGreater(len(checkpoints), 50)

        # Second run: modified groups narrow by timeStamp, append-only ledgers
        # by id, reports by date; reference tables re-snapshot in full.
        MockLightspeed.calls = []
        sync2, summary2, emitted2 = self._run(configuration, client, state=sync.state,
                                              now=datetime(2026, 8, 18, tzinfo=timezone.utc))
        sale_calls = [c for c in MockLightspeed.calls if c[0].endswith("/Sale.json")]
        self.assertEqual(sale_calls[0][1]["updateTime"], [">=,2026-08-16T23:55:00+00:00"])
        log_calls = [c for c in MockLightspeed.calls if c[0].endswith("/InventoryLog.json")]
        self.assertEqual(log_calls[0][1]["inventoryLogID"][0][:2], ">,")
        report_calls = [c for c in MockLightspeed.calls if c[0].endswith("/PaymentsByDay.json")]
        self.assertEqual(report_calls[0][1]["endDate"], ["2026-08-18"])
        self.assertNotIn("sort", report_calls[0][1])
        shop_calls = [c for c in MockLightspeed.calls if c[0].endswith("/Shop.json")]
        self.assertNotIn("timeStamp", shop_calls[0][1])
        self.assertNotIn(CONTRACT_TABLE, emitted2)  # contract already landed for this spec
        self.assertEqual(sync2.state["groups"]["Sale"]["watermark"], "2026-08-18T00:00:00+00:00")

    def test_pagination_follows_after_and_resumes_after_interruption(self):
        MockLightspeed.calls = []
        MockLightspeed.paginate = {"Sale": 2}
        self.addCleanup(lambda: setattr(MockLightspeed, "paginate", {}))
        configuration, client = self._client()
        checkpoints: list = []
        sync, summary, emitted = self._run(configuration, client, checkpoints=checkpoints)
        sale_calls = [c for c in MockLightspeed.calls if c[0].endswith("/Sale.json")]
        self.assertEqual([c[1].get("after", [None])[0] for c in sale_calls], [None, "cursor-1", "cursor-2"])
        # A continuation request carries only `after` (+ relations), never sort/limit.
        self.assertNotIn("sort", sale_calls[1][1])
        self.assertIn("load_relations", sale_calls[1][1])
        self.assertEqual(len(emitted["ls_sales"]), 3)
        # Mid-walk state carried the cursor; a run resumed from it continues at page 2.
        mid = next(s for s in checkpoints if s["groups"].get("Sale", {}).get("cursor", {}).get("after") == "cursor-1")
        MockLightspeed.calls = []
        _, _, resumed = self._run(configuration, client, state=mid)
        sale_calls = [c for c in MockLightspeed.calls if c[0].endswith("/Sale.json")]
        self.assertEqual(sale_calls[0][1]["after"], ["cursor-1"])

    def test_absent_endpoint_is_recorded_not_fatal(self):
        MockLightspeed.absent = {"Workorder", "CustomField"}
        self.addCleanup(lambda: setattr(MockLightspeed, "absent", set()))
        configuration, client = self._client()
        sync, summary, emitted = self._run(configuration, client)
        self.assertNotIn("ls_workorders", emitted)
        self.assertIn("ls_sales", emitted)
        self.assertIn("404", sync.state["groups"]["Workorder"]["unavailable"])
        self.assertIn("404", sync.state["fanouts"]["ls_custom_field_choices"]["unavailable"])
        self.assertGreaterEqual(summary["unavailable"], 2)

    def test_silently_dropped_relation_rejects_the_page(self):
        MockLightspeed.strip_relation = ("Item", "ItemShops")
        self.addCleanup(lambda: setattr(MockLightspeed, "strip_relation", None))
        configuration, client = self._client()
        sync, summary, emitted = self._run(configuration, client)
        self.assertNotIn("ls_items", emitted)  # the page is rejected, not half-landed
        self.assertIn("ItemShops", sync.state["groups"]["Item"]["error"])
        self.assertIn("ls_sales", emitted)
        self.assertEqual(summary["errors"], 1)

    def test_refused_relation_is_dropped_and_remembered(self):
        MockLightspeed.calls = []
        MockLightspeed.refuse_relation = {"ItemFee": "ItemFeeCategories"}
        self.addCleanup(lambda: setattr(MockLightspeed, "refuse_relation", {}))
        configuration, client = self._client()
        sync, summary, emitted = self._run(configuration, client)
        self.assertIn("ls_item_fees", emitted)
        self.assertEqual(sync.state["groups"]["ItemFee"]["dropped_relations"], ["ItemFeeCategories"])
        fee_calls = [c for c in MockLightspeed.calls if c[0].endswith("/ItemFee.json")]
        self.assertEqual(len(fee_calls), 2)
        self.assertNotIn("load_relations", fee_calls[1][1])
        # The next run never asks for it again.
        MockLightspeed.calls = []
        self._run(configuration, client, state=sync.state)
        fee_calls = [c for c in MockLightspeed.calls if c[0].endswith("/ItemFee.json")]
        self.assertEqual(len(fee_calls), 1)

    def test_silently_dropped_relation_retries_with_member_roots_only(self):
        # Vendor drops ItemShops (a REQUIRED member root) whenever more than 4 relations are asked for.
        MockLightspeed.calls = []
        MockLightspeed.drop_when_many = {"Item": ("ItemShops", 4)}
        self.addCleanup(lambda: setattr(MockLightspeed, "drop_when_many", {}))
        configuration, client = self._client()
        sync, summary, emitted = self._run(configuration, client)
        self.assertIn("ls_item_shops", emitted)
        self.assertNotIn("error", sync.state["groups"]["Item"])
        item_calls = [c for c in MockLightspeed.calls if c[0].endswith("/Item.json")]
        self.assertGreaterEqual(len(item_calls), 2)
        second = json.loads(item_calls[1][1]["load_relations"][0])
        self.assertLessEqual(len(second), 4)
        self.assertIn("ItemShops", second)

    def test_item_prices_project_from_the_live_prices_alias(self):
        from lightspeed_projection import project_member_rows
        group = next(g for g in SPEC["groups"] if g["resource"] == "Item")
        member = next(m for m in group["members"] if m["table"] == "ls_item_prices")
        record = {"itemID": "5", "Prices": {"ItemPrice": [{"amount": "10.0000", "useType": "Default", "useTypeID": "1"}]}}
        rows = project_member_rows(group, member, [record])
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["fields"]["amount"], "10.0000")

    def test_throttle_is_retried(self):
        MockLightspeed.calls = []
        MockLightspeed.throttle_once = {"Sale"}
        configuration, client = self._client()
        _, _, emitted = self._run(configuration, client)
        self.assertIn("ls_sales", emitted)
        self.assertEqual(len([c for c in MockLightspeed.calls if c[0].endswith("/Sale.json")]), 2)

    def test_remote_disconnect_is_retried(self):
        MockLightspeed.calls = []
        MockLightspeed.drop_once = {"Sale"}
        self.addCleanup(lambda: setattr(MockLightspeed, "drop_once", set()))
        configuration, client = self._client()
        _, _, emitted = self._run(configuration, client)
        self.assertIn("ls_sales", emitted)
        self.assertEqual(len([c for c in MockLightspeed.calls if c[0].endswith("/Sale.json")]), 2)

    def test_dead_token_is_fatal(self):
        MockLightspeed.token_dead = True
        self.addCleanup(lambda: setattr(MockLightspeed, "token_dead", False))
        _, client = self._client()
        with self.assertRaises(lightspeed_client.LightspeedError) as raised:
            client.get_json("Sale.json")
        self.assertNotIsInstance(raised.exception, lightspeed_client.NotAvailable)

    def test_schema_declares_every_table_with_control_columns(self):
        tables = spec_schema()
        self.assertEqual(len(tables), len(TABLES) + 1)
        by_name = {t["table"]: t for t in tables}
        self.assertEqual(by_name["ls_sales"]["primary_key"], ["source_record_id"])
        self.assertEqual(by_name["ls_sales"]["columns"]["calc_total"], {"type": "DECIMAL", "precision": 19, "scale": 4})
        self.assertEqual(by_name["ls_sales"]["columns"]["completed"], "BOOLEAN")
        self.assertEqual(by_name["ls_sales"]["columns"]["complete_time"], "UTC_DATETIME")
        self.assertEqual(by_name["ls_sales"]["columns"]["tombstone"], "BOOLEAN")
        # 0125 parent-context columns are part of the landed shape.
        self.assertIn("vendor_id", by_name["ls_purchase_order_lines"]["columns"])
        self.assertIn("shop_id", by_name["ls_sale_payments"]["columns"])

    def test_typed_record_handles_vendor_strings(self):
        table = TABLES["ls_sales"]
        row = {"sourceRecordId": "x", "updatedAt": None,
               "fields": {"saleID": "9", "total": "12.5", "completed": "true", "completeTime": "2026-07-31T01:00:00+10:00"}}
        record = row_to_record(table, row, datetime(2026, 8, 17, tzinfo=timezone.utc))
        self.assertEqual(record["sale_id"], "9.0000")
        self.assertEqual(record["total"], "12.5000")
        self.assertIs(record["completed"], True)
        self.assertEqual(record["complete_time"].isoformat(), "2026-07-30T15:00:00+00:00")
        self.assertIsNone(record["customer_id"])
        self.assertIsNone(record["source_updated_at"])


if __name__ == "__main__":
    unittest.main()
