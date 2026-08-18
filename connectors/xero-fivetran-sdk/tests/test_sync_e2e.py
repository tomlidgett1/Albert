"""
End-to-end against a mock Xero built from the sanitized recording: every
group endpoint and fan-out sub-request is served from the fixture, so the full
walk (pagination, If-Modified-Since, fan-out id resolution, typed emit,
checkpoints, reports flattening) runs exactly as it would against Xero.

Run: python3 -m unittest discover -s connectors/xero-fivetran-sdk/tests -v
"""
from __future__ import annotations

import json
import os
import re
import sys
import threading
import unittest
from datetime import date, datetime, timezone
from decimal import Decimal
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))

import xero_client  # noqa: E402
from xero_client import TokenSupply, XeroClient  # noqa: E402
from xero_reports import XeroReports  # noqa: E402
from xero_spec import SPEC  # noqa: E402
from xero_sync import XeroSync, row_to_record, spec_schema  # noqa: E402

xero_client.MIN_INTERVAL_SECONDS = 0.0  # the mock has no rate limit


def _load(name: str):
    with open(os.path.join(HERE, name), encoding="utf-8") as handle:
        return json.load(handle)


RECORDING = _load("sanitized-recording.json")["responses"]
TABLES = SPEC["tables"]

# Path → response body. Group leaders by their walk path; fan-outs by a regex
# built from their path template ({Param} → one path segment).
EXACT: dict[str, dict] = {}
PATTERNS: list[tuple[re.Pattern, str, dict]] = []
for group in SPEC["groups"]:
    body = RECORDING.get(group["leader"])
    if body is not None:
        EXACT.setdefault(group["path"], body)
for fan_out in SPEC["fanOuts"]:
    body = RECORDING.get(fan_out["id"])
    if body is None or fan_out.get("templatedParents"):
        continue
    if "{" in fan_out["path"]:
        pattern = re.compile("^" + re.sub(r"\{[^}]+\}", "[^/]+", re.escape(fan_out["path"]).replace(r"\{", "{").replace(r"\}", "}")) + "$")
        PATTERNS.append((pattern, fan_out["id"], body))
    else:
        EXACT.setdefault(fan_out["path"], body)

ORGANISATION = {"Organisations": [{"Name": "Mock Org", "Version": "AU", "FinancialYearEndDay": 30, "FinancialYearEndMonth": 6}]}

PNL_REPORT = {"Reports": [{
    "ReportID": "ProfitAndLoss", "ReportName": "Profit and Loss", "UpdatedDateUTC": "/Date(1786924800000)/",
    "Rows": [
        {"RowType": "Header", "Cells": [{"Value": ""}, {"Value": "31 Jul 26"}, {"Value": "30 Jun 26"}]},
        {"RowType": "Section", "Title": "Income", "Rows": [
            {"RowType": "Row", "Cells": [
                {"Value": "Sales", "Attributes": [{"Id": "account", "Value": "acc-sales"}]},
                {"Value": "1499.00", "Attributes": [{"Id": "account", "Value": "acc-sales"}]},
                {"Value": "1200.50", "Attributes": [{"Id": "account", "Value": "acc-sales"}]},
            ]},
            {"RowType": "SummaryRow", "Cells": [{"Value": "Total Income"}, {"Value": "1499.00"}, {"Value": "1200.50"}]},
        ]},
        {"RowType": "Section", "Title": "", "Rows": [
            {"RowType": "Row", "Cells": [{"Value": "Net Profit"}, {"Value": "(10.00)"}, {"Value": "5.00"}]},
        ]},
    ],
}]}
TB_REPORT = {"Reports": [{
    "ReportID": "TrialBalance", "ReportName": "Trial Balance", "UpdatedDateUTC": "/Date(1786924800000)/",
    "Rows": [
        {"RowType": "Header", "Cells": [{"Value": "Account"}, {"Value": "Debit"}, {"Value": "Credit"}, {"Value": "YTD Debit"}, {"Value": "YTD Credit"}]},
        {"RowType": "Section", "Title": "Revenue", "Rows": [
            {"RowType": "Row", "Cells": [
                {"Value": "Sales (200)", "Attributes": [{"Id": "account", "Value": "acc-sales"}]},
                {"Value": ""}, {"Value": "1499.00"}, {"Value": ""}, {"Value": "9000.00"},
            ]},
        ]},
    ],
}]}


class MockXero(BaseHTTPRequestHandler):
    calls: list = []
    stamp = "Mon, 17 Aug 2026 00:00:00 GMT"
    # Paths that answer 401 the way Xero does for a scope the app cannot hold.
    scope_denied: set = set()
    # When set, every request 401s: a genuinely dead token.
    token_dead = False

    def log_message(self, *_args):  # quiet
        return

    def do_GET(self):  # noqa: N802
        parsed = urlparse(self.path)
        path = parsed.path
        MockXero.calls.append((path, parse_qs(parsed.query), {k.lower(): v for k, v in self.headers.items()}))
        if MockXero.token_dead or path in MockXero.scope_denied:
            payload = b'{"Type":"UnauthorizedError","Title":"Unauthorized"}'
            self.send_response(401)
            self.send_header("content-length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)
            return
        if path == "/connections":
            return self._json([{"tenantId": "tenant-1", "tenantType": "ORGANISATION"}])
        if path.endswith("/Organisation"):
            return self._json(ORGANISATION)
        if "/Reports/ProfitAndLoss" in path or "/Reports/BalanceSheet" in path or "/Reports/BudgetSummary" in path \
                or "/Reports/ExecutiveSummary" in path:
            return self._json(PNL_REPORT)
        if "/Reports/TrialBalance" in path or "/Reports/BankSummary" in path:
            return self._json(TB_REPORT)
        if self.headers.get("if-modified-since"):
            self.send_response(304)
            self.end_headers()
            return
        params = parse_qs(parsed.query)
        # Xero's Quotes endpoint rejects order/where clauses other walks accept.
        if path.endswith("/Quotes") and ("order" in params or "where" in params):
            payload = json.dumps({"ErrorNumber": 16, "Type": "QueryParseException", "Message": "OrderBy not supported"}).encode()
            self.send_response(400)
            self.send_header("content-length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)
            return
        page = int(params.get("page", ["1"])[0]) if "page" in params else 1
        if page > 1 or (params.get("offset") and params["offset"][0] != "0"):
            return self._json({"Empty": []})
        body = EXACT.get(path)
        if body is None:
            for pattern, _table, candidate in PATTERNS:
                if pattern.match(path):
                    body = candidate
                    break
        if body is None:
            self.send_response(404)
            self.end_headers()
            self.wfile.write(b'{"Message":"not found"}')
            return
        return self._json(body)

    def _json(self, body):
        payload = json.dumps(body).encode("utf-8")
        self.send_response(200)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)


class SyncEndToEnd(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = ThreadingHTTPServer(("127.0.0.1", 0), MockXero)
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()
        cls.origin = f"http://127.0.0.1:{cls.server.server_address[1]}"

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()

    def _client(self):
        configuration = {"xero_access_token": "debug-token", "xero_tenant_id": "tenant-1"}
        return configuration, XeroClient(configuration, TokenSupply(configuration), origin=self.origin)

    def test_full_walk_then_incremental_noop(self):
        MockXero.calls = []
        configuration, client = self._client()
        emitted: dict[str, list] = {}
        checkpoints: list = []
        sync = XeroSync(configuration, {}, lambda t, r: emitted.setdefault(t, []).append(r),
                        lambda s: checkpoints.append(json.loads(json.dumps(s))), client=client,
                        now=datetime(2026, 8, 17, tzinfo=timezone.utc))
        summary = sync.run()
        self.assertIsNone(summary["stopped_early"])
        self.assertGreater(summary["rows"], 40)
        # Leader + nested member from one walk.
        self.assertIn("xero_invoices", emitted)
        self.assertIn("xero_invoice_line_items", emitted)
        invoice = emitted["xero_invoices"][0]
        self.assertEqual(invoice["source_record_id"], "00000000-0000-4000-8000-000000000004")
        self.assertEqual(invoice["contact_contact_id"], "00000000-0000-4000-8000-000000000003")
        self.assertEqual(invoice["total"], "1499.00000000")
        self.assertEqual(invoice["date"], date(2026, 7, 31))
        self.assertEqual(invoice["updated_date_utc"], datetime(2026, 7, 31, 5, 0, tzinfo=timezone.utc))
        self.assertIs(invoice["tombstone"], False)
        line = emitted["xero_invoice_line_items"][0]
        self.assertEqual(line["invoice_id"], invoice["invoice_id"])
        self.assertEqual(line["line_items_line_amount"], "1362.72730000")
        # Quotes rejects order/where with QueryParseException; the walk retries
        # without the clauses instead of losing the family.
        self.assertIn("xero_quotes", emitted)
        quote_calls = [c for c in MockXero.calls if c[0].endswith("/Quotes")]
        self.assertTrue(any("order" not in c[1] and "where" not in c[1] for c in quote_calls))
        # AU payroll enabled from Organisation.Version, UK/NZ not walked.
        self.assertIn("xero_payroll_au_pay_runs", emitted)
        self.assertNotIn("xero_payroll_uk_pay_runs", emitted)
        # Fan-out: payslip detail keyed to the pay run's payslip stubs.
        self.assertIn("xero_payroll_au_payslips", emitted)
        payslip_calls = [c for c in MockXero.calls if "/payroll.xro/1.0/Payslip/" in c[0]]
        self.assertGreater(len(payslip_calls), 0)
        # Walk parameters: ordered pages with an immutable upper bound.
        invoice_calls = [c for c in MockXero.calls if c[0].endswith("/Invoices")]
        self.assertEqual(invoice_calls[0][1]["order"], ["UpdatedDateUTC ASC,InvoiceID ASC"])
        self.assertEqual(invoice_calls[0][1]["unitdp"], ["4"])
        self.assertTrue(invoice_calls[0][1]["where"][0].startswith("UpdatedDateUTC<DateTime(2026,8,17,"))
        # Every walked group checkpointed a watermark.
        self.assertTrue(all("watermark" in v or "unavailable" in v for v in sync.state["groups"].values()))
        self.assertGreater(len(checkpoints), 50)

        # Second run: If-Modified-Since from the watermark → 304s → nothing re-emitted.
        MockXero.calls = []
        emitted2: dict[str, list] = {}
        sync2 = XeroSync(configuration, json.loads(json.dumps(sync.state)),
                         lambda t, r: emitted2.setdefault(t, []).append(r), lambda s: None, client=client,
                         now=datetime(2026, 8, 18, tzinfo=timezone.utc))
        summary2 = sync2.run()
        # Modified-field walks are 304 → silent; only reference tables without a
        # modified watermark (branding themes, currencies, assets…) re-upsert.
        self.assertNotIn("xero_invoices", emitted2)
        self.assertNotIn("xero_payroll_au_payslips", emitted2)
        self.assertNotIn("xero_contacts", emitted2)
        self.assertLess(summary2["rows"], summary["rows"] / 2)
        ims_calls = [c for c in MockXero.calls if c[2].get("if-modified-since")]
        self.assertGreater(len(ims_calls), 20)
        self.assertEqual(ims_calls[0][2]["if-modified-since"], "Mon, 17 Aug 2026 00:00:00 GMT")

    def test_scope_401_marks_group_unavailable(self):
        """Xero 401s (not 403s) endpoints whose scope the app cannot hold; the
        sync must record the group as unavailable and carry on, not die."""
        MockXero.calls = []
        MockXero.scope_denied = {"/api.xro/2.0/ExpenseClaims"}
        self.addCleanup(lambda: setattr(MockXero, "scope_denied", set()))
        configuration, client = self._client()
        emitted: dict[str, list] = {}
        sync = XeroSync(configuration, {}, lambda t, r: emitted.setdefault(t, []).append(r), lambda s: None,
                        client=client, now=datetime(2026, 8, 17, tzinfo=timezone.utc))
        summary = sync.run()
        self.assertIsNone(summary["stopped_early"])
        self.assertIn("xero_invoices", emitted)
        self.assertNotIn("xero_expense_claims", emitted)
        denied = [v for k, v in sync.state["groups"].items() if k.startswith("xero_expense_claim") or "unavailable" in v]
        self.assertTrue(any("401" in v.get("unavailable", "") for v in denied))
        # One retry with a refreshed token, then one /connections probe — not a fatal loop.
        claim_calls = [c for c in MockXero.calls if c[0] == "/api.xro/2.0/ExpenseClaims"]
        self.assertEqual(len(claim_calls), 2)
        paths = [c[0] for c in MockXero.calls]
        second_denied = len(paths) - 1 - paths[::-1].index("/api.xro/2.0/ExpenseClaims")
        self.assertEqual(paths[second_denied + 1], "/connections")  # the token probe

    def test_dead_token_is_fatal(self):
        MockXero.token_dead = True
        self.addCleanup(lambda: setattr(MockXero, "token_dead", False))
        configuration, client = self._client()
        with self.assertRaises(xero_client.XeroError) as raised:
            client.get_json("/api.xro/2.0/Invoices")
        self.assertNotIsInstance(raised.exception, xero_client.NotAvailable)

    def test_reports_flatten(self):
        configuration, client = self._client()
        emitted: dict[str, list] = {}
        reports = XeroReports(client, lambda t, r: emitted.setdefault(t, []).append(r),
                              ORGANISATION["Organisations"][0], today=date(2026, 8, 17))
        summary = reports.run()
        self.assertGreater(summary["rows"], 0)
        pnl = emitted["xero_report_profit_and_loss_lines"]
        sales = [r for r in pnl if r["row_title"] == "Sales" and r["basis"] == "ACCRUAL" and r["period_end"] == date(2026, 7, 31)]
        # The mock serves the same grid for both 12-month windows, so the line
        # is emitted twice — with the same key, i.e. an idempotent re-upsert.
        self.assertEqual(len({r["source_record_id"] for r in sales}), 1)
        self.assertEqual(sales[0]["amount"], "1499.00000000")
        self.assertEqual(sales[0]["account_id"], "acc-sales")
        self.assertEqual(sales[0]["section"], "Income")
        self.assertEqual(sales[0]["period_start"], date(2026, 7, 1))
        net = [r for r in pnl if r["row_title"] == "Net Profit" and r["period_end"] == date(2026, 7, 31) and r["basis"] == "CASH"]
        self.assertEqual(net[0]["amount"], "-10.00000000")
        # Keys are stable across runs (same input → same source_record_id).
        emitted_again: dict[str, list] = {}
        XeroReports(client, lambda t, r: emitted_again.setdefault(t, []).append(r),
                    ORGANISATION["Organisations"][0], today=date(2026, 8, 17)).run()
        self.assertEqual({r["source_record_id"] for r in pnl},
                         {r["source_record_id"] for r in emitted_again["xero_report_profit_and_loss_lines"]})
        tb = emitted["xero_report_trial_balance_lines"]
        self.assertTrue(any(r["credit"] == "1499.00000000" and r["ytd_credit"] == "9000.00000000" for r in tb))
        self.assertIn("xero_report_bank_summary_lines", emitted)

    def test_schema_declares_every_table_with_control_columns(self):
        tables = spec_schema()
        self.assertEqual(len(tables), len(TABLES))
        by_name = {t["table"]: t for t in tables}
        self.assertEqual(by_name["xero_invoices"]["primary_key"], ["source_record_id"])
        self.assertEqual(by_name["xero_invoices"]["columns"]["total"], {"type": "DECIMAL", "precision": 30, "scale": 8})
        self.assertEqual(by_name["xero_invoices"]["columns"]["date"], "NAIVE_DATE")
        self.assertEqual(by_name["xero_invoices"]["columns"]["updated_date_utc"], "UTC_DATETIME")

    def test_typed_record_handles_xero_shapes(self):
        table = TABLES["xero_invoices"]
        row = {"sourceRecordId": "x", "fields": {"Total": 12.5, "Date": "/Date(1785474000000+0000)/",
                                                 "UpdatedDateUTC": "2026-07-31T01:00:00.1234567", "HasAttachments": "false"},
               "tombstone": False, "updatedAt": None}
        record = row_to_record(table, row, datetime(2026, 8, 17, tzinfo=timezone.utc))
        self.assertEqual(record["total"], "12.50000000")
        self.assertEqual(record["date"], date(2026, 7, 31))
        self.assertEqual(record["updated_date_utc"].isoformat(), "2026-07-31T01:00:00.123456+00:00")
        self.assertIs(record["has_attachments"], False)
        self.assertIsNone(record["contact_name"])


if __name__ == "__main__":
    unittest.main()
