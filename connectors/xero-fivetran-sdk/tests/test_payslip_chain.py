"""
Payroll AU payslip chain (PARENT_DETAIL_CHAINS in xero_sync.py).

Xero's GET /PayRuns never carries the Payslips array — only
GET /PayRuns/{PayRunID} does — so the payslip fan-out must fetch each new or
updated pay run's detail, land the PayslipSummary rows it carries (the shape
source_xero_official.xo_payslip_summaries reads out of
xero_payroll_au_payslips joined to xero_payroll_au_pay_runs) and chain
GET /Payslip/{PayslipID} from those ids. Before this the fan-out fell back to
the PayRunID and every sub-request 404'd: 485 posted pay runs, zero payslips
(verified 2026-09-01).

The client is scripted in-process — no network, no threads.

Run: python3 -m unittest discover -s connectors/xero-fivetran-sdk/tests -v
"""
from __future__ import annotations

import json
import os
import sys
import unittest
from datetime import datetime, timedelta, timezone
from decimal import Decimal

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))

from xero_client import BudgetReserveReached, DailyLimitReached, NotAvailable  # noqa: E402
from xero_spec import SPEC  # noqa: E402
from xero_sync import CHAIN_UNAVAILABLE_PROBES, CHAIN_VERSION, XeroSync, http_date  # noqa: E402

FAN_OUT = next(f for f in SPEC["fanOuts"] if f["id"] == "xero_payroll_au_payslips")
TABLES = SPEC["tables"]
PAY_RUNS = "/payroll.xro/1.0/PayRuns"
PAYSLIP = "/payroll.xro/1.0/Payslip"
NOW = datetime(2026, 9, 1, 8, 0, tzinfo=timezone.utc)
STAMP_1 = "/Date(1787000000000+0000)/"
STAMP_2 = "/Date(1787100000000+0000)/"
CONFIGURATION = {"xero_access_token": "debug-token", "xero_tenant_id": "tenant-1", "payroll_region": "AU"}


def pay_run(pay_run_id: str, status: str = "POSTED", updated: str = STAMP_1, payslips: list | None = None) -> dict:
    record = {
        "PayRunID": pay_run_id, "PayrollCalendarID": "cal-fortnightly",
        "PayRunPeriodStartDate": "/Date(1786320000000+0000)/", "PayRunPeriodEndDate": "/Date(1787443200000+0000)/",
        "PayRunStatus": status, "PaymentDate": "/Date(1787529600000+0000)/", "PayslipMessage": "",
        "Wages": 2400.0, "Deductions": 0.0, "Tax": 480.0, "Super": 276.0, "Reimbursement": 0.0, "NetPay": 1920.0,
        "UpdatedDateUTC": updated,
    }
    if payslips is not None:
        record["Payslips"] = payslips  # only the detail endpoint carries these
    return record


def summary(payslip_id: str, employee_id: str, first_name: str, last_name: str, wages: float = 1500.0,
            edited: str = STAMP_1) -> dict:
    """A PayslipSummary exactly as GET /PayRuns/{PayRunID} returns it."""
    return {
        "EmployeeID": employee_id, "PayslipID": payslip_id, "FirstName": first_name, "LastName": last_name,
        "EmployeeGroup": "Workshop", "LastEdited": edited,
        "Wages": wages, "Deductions": 0.0, "NetPay": round(wages * 0.8, 2), "Tax": round(wages * 0.2, 2),
        "Super": round(wages * 0.115, 2), "Reimbursements": 0.0,
    }


def payslip_detail(stub: dict, pay_run_id: str) -> dict:
    """GET /Payslip/{PayslipID}: the summary fields plus every line array."""
    return {"Payslip": {
        "PayslipID": stub["PayslipID"], "PayRunID": pay_run_id, "EmployeeID": stub["EmployeeID"],
        "FirstName": stub["FirstName"], "LastName": stub["LastName"],
        "Wages": stub["Wages"], "Deductions": 0.0, "Tax": stub["Tax"], "Super": stub["Super"],
        "Reimbursements": 0.0, "NetPay": stub["NetPay"], "UpdatedDateUTC": stub["LastEdited"],
        "EarningsLines": [{"EarningsRateID": "rate-ordinary", "RatePerUnit": 39.47, "NumberOfUnits": 38.0}],
        "LeaveEarningsLines": [], "TimesheetEarningsLines": [], "DeductionLines": [], "ReimbursementLines": [],
        "LeaveAccrualLines": [{"LeaveTypeID": "leave-annual", "NumberOfUnits": 5.846, "AutoCalculate": True}],
        "SuperannuationLines": [{"SuperMembershipID": "super-1", "ContributionType": "SGC",
                                 "CalculationType": "PERCENTAGEOFEARNINGS", "Percentage": 11.5,
                                 "Amount": stub["Super"]}],
        "TaxLines": [],
    }}


def routes_for(runs: list, details: dict, payslips: list) -> dict:
    routes = {PAY_RUNS: {"PayRuns": runs}}
    for pay_run_id, detail in details.items():
        routes[f"{PAY_RUNS}/{pay_run_id}"] = {"PayRuns": [detail]}
    for stub, pay_run_id in payslips:
        routes[f"{PAYSLIP}/{stub['PayslipID']}"] = payslip_detail(stub, pay_run_id)
    return routes


class ScriptedXero:
    """In-process stand-in for XeroClient: canned bodies by path, every request
    recorded, If-Modified-Since answered like Xero (304 unless the path has a
    `modified` body), unscripted or denied paths as NotAvailable, and an
    optional request budget that trips the daily reserve mid-walk."""

    def __init__(self, routes: dict, modified: dict | None = None, unavailable=(), budget: int | None = None):
        self.routes = dict(routes)
        self.modified = dict(modified or {})
        self.unavailable = set(unavailable)
        self.budget = budget
        self.requests: list[tuple[str, dict, dict]] = []
        self.calls = 0
        self.day_remaining = None
        self.daily_reserve = 0

    def get_json(self, path: str, params: dict | None = None, headers: dict | None = None, tenant_scoped: bool = True):
        if self.budget is not None and self.calls >= self.budget:
            raise BudgetReserveReached(f"Xero daily allowance down to the reserve before {path}")
        lowered = {key.lower(): value for key, value in (headers or {}).items()}
        self.requests.append((path, dict(params or {}), lowered))
        self.calls += 1
        if path in self.unavailable:
            raise NotAvailable(f"404 for {path}")
        if lowered.get("if-modified-since"):
            body = self.modified.get(path)
            return (304, None) if body is None else (200, body)
        if path not in self.routes:
            raise NotAvailable(f"404 for {path}: not scripted")
        return 200, self.routes[path]

    def paths(self, prefix: str) -> list[str]:
        return [path for path, _params, _headers in self.requests if path.startswith(prefix)]


def make_sync(client: ScriptedXero, state: dict | None = None, now: datetime = NOW):
    emitted: dict[str, list] = {}
    checkpoints: list = []
    sync = XeroSync(CONFIGURATION, state if state is not None else {},
                    lambda table, record: emitted.setdefault(table, []).append(record),
                    lambda snapshot: checkpoints.append(json.loads(json.dumps(snapshot, default=str))),
                    client=client, now=now)
    return sync, emitted, checkpoints


A, B, C = "run-a", "run-b", "run-c"
A1 = summary("slip-a1", "emp-ada", "Ada", "Lovelace")
A2 = summary("slip-a2", "emp-grace", "Grace", "Hopper", wages=900.0)
B1 = summary("slip-b1", "emp-ada", "Ada", "Lovelace")
B1_LATER = summary("slip-b1", "emp-ada", "Ada", "Lovelace", wages=1600.0, edited=STAMP_2)
C1 = summary("slip-c1", "emp-ada", "Ada", "Lovelace", edited=STAMP_2)


def first_pass_routes() -> dict:
    return routes_for(
        runs=[pay_run(A), pay_run(B)],
        details={A: pay_run(A, payslips=[A1, A2]), B: pay_run(B, payslips=[B1])},
        payslips=[(A1, A), (A2, A), (B1, B)],
    )


class PayslipChain(unittest.TestCase):
    def test_pay_run_detail_then_payslips_from_its_ids(self):
        """The chain fetches PayRuns/{PayRunID} for every run the list returned
        and Payslip/{PayslipID} for exactly the ids that detail carried — never
        the PayRunID the old fallback used."""
        client = ScriptedXero(first_pass_routes())
        sync, _emitted, _ = make_sync(client)
        sync.sync_fan_out(FAN_OUT)
        self.assertEqual(client.paths(PAY_RUNS + "/"), [f"{PAY_RUNS}/{A}", f"{PAY_RUNS}/{B}"])
        self.assertEqual(client.paths(PAYSLIP + "/"),
                         [f"{PAYSLIP}/slip-a1", f"{PAYSLIP}/slip-a2", f"{PAYSLIP}/slip-b1"])
        self.assertEqual(client.calls, 1 + 2 + 3)  # the list, two run details, three payslips
        self.assertEqual(sync.state["fanouts"]["xero_payroll_au_payslips"],
                         {"watermark": NOW.isoformat(), "chain": CHAIN_VERSION})
        stats = sync.chain_stats["xero_payroll_au_payslips"]
        self.assertEqual((stats["parents"], stats["parent_calls"], stats["stub_calls"]), (2, 2, 3))

    def test_summary_rows_land_the_payslip_summary_columns(self):
        """Each Payslips element lands in xero_payroll_au_payslips with the
        columns xo_payslip_summaries reads, keyed on PayslipID and joined to the
        pay run by pay_run_id; the pay run row is re-landed with the array; the
        chained detail then completes the same key with its line tables."""
        client = ScriptedXero(first_pass_routes())
        sync, emitted, _ = make_sync(client)
        sync.sync_fan_out(FAN_OUT)
        rows = emitted["xero_payroll_au_payslips"]
        a2_rows = [row for row in rows if row["source_record_id"] == "slip-a2"]
        self.assertEqual(len(a2_rows), 2)  # summary from the pay run detail, then the payslip detail
        summary_row, detail_row = a2_rows
        expected_stamp = datetime.fromtimestamp(1787000000, tz=timezone.utc)
        self.assertEqual(summary_row["payslip_id"], "slip-a2")
        self.assertEqual(summary_row["pay_run_id"], A)
        self.assertEqual(summary_row["employee_id"], "emp-grace")
        self.assertEqual(summary_row["first_name"], "Grace")
        self.assertEqual(summary_row["last_name"], "Hopper")
        self.assertEqual(summary_row["wages"], "900.00000000")
        self.assertEqual(summary_row["tax"], "180.00000000")
        self.assertEqual(summary_row["super"], "103.50000000")
        # A JSON 0.0 quantizes to Decimal('0E-8') in _to_decimal (pre-existing,
        # every table): compare zero amounts as numbers.
        self.assertEqual(Decimal(summary_row["deductions"]), Decimal(0))
        self.assertEqual(Decimal(summary_row["reimbursements"]), Decimal(0))
        self.assertEqual(summary_row["net_pay"], "720.00000000")
        self.assertEqual(summary_row["payslips_employee_group"], "Workshop")
        self.assertEqual(summary_row["updated_date_utc"], expected_stamp)  # PayslipSummary.LastEdited
        self.assertEqual(summary_row["source_updated_at"], expected_stamp)
        self.assertIs(summary_row["tombstone"], False)
        self.assertIsNone(summary_row["earnings_lines"])  # a summary carries no lines
        self.assertEqual(detail_row["earnings_lines"][0]["EarningsRateID"], "rate-ordinary")
        self.assertEqual(detail_row["pay_run_id"], A)
        self.assertEqual(detail_row["payslips_employee_group"], "Workshop")
        self.assertEqual(detail_row["wages"], "900.00000000")
        # Line tables from the detail, keyed to the payslip.
        rate_column = next(column["name"] for column in TABLES["xero_payroll_au_payslip_earnings_lines"]["columns"]
                           if column["api"].endswith("EarningsRateID"))
        self.assertEqual({(row["payslip_id"], row[rate_column]) for row in emitted["xero_payroll_au_payslip_earnings_lines"]},
                         {("slip-a1", "rate-ordinary"), ("slip-a2", "rate-ordinary"), ("slip-b1", "rate-ordinary")})
        self.assertEqual({row["payslip_id"] for row in emitted["xero_payroll_au_payslip_superannuation_lines"]},
                         {"slip-a1", "slip-a2", "slip-b1"})
        self.assertEqual({row["payslip_id"] for row in emitted["xero_payroll_au_payslip_leave_accrual_lines"]},
                         {"slip-a1", "slip-a2", "slip-b1"})
        # The pay run row again, now carrying what the list omitted.
        run_rows = [row for row in emitted["xero_payroll_au_pay_runs"] if row["source_record_id"] == A]
        self.assertEqual([stub["PayslipID"] for stub in run_rows[-1]["payslips"]], ["slip-a1", "slip-a2"])
        self.assertEqual(run_rows[-1]["pay_run_status"], "POSTED")
        self.assertEqual(run_rows[-1]["wages"], "2400.00000000")

    def test_later_syncs_fetch_only_new_or_updated_runs(self):
        """After a complete pass the parent walk is If-Modified-Since from the
        chain watermark: an unchanged posted run costs nothing; a run Xero
        reports modified and a new run are fetched (detail + their payslips)."""
        client = ScriptedXero(first_pass_routes())
        sync, _emitted, _ = make_sync(client)
        sync.sync_fan_out(FAN_OUT)
        state = json.loads(json.dumps(sync.state))

        later = NOW + timedelta(days=1)
        routes = routes_for(
            runs=[pay_run(A), pay_run(B, updated=STAMP_2), pay_run(C, status="DRAFT", updated=STAMP_2)],
            details={A: pay_run(A, payslips=[A1, A2]), B: pay_run(B, updated=STAMP_2, payslips=[B1_LATER]),
                     C: pay_run(C, status="DRAFT", updated=STAMP_2, payslips=[C1])},
            payslips=[(A1, A), (A2, A), (B1_LATER, B), (C1, C)],
        )
        modified = {PAY_RUNS: {"PayRuns": [pay_run(B, updated=STAMP_2), pay_run(C, status="DRAFT", updated=STAMP_2)]}}
        client2 = ScriptedXero(routes, modified=modified)
        sync2, emitted2, _ = make_sync(client2, state=state, now=later)
        sync2.sync_fan_out(FAN_OUT)
        list_calls = [request for request in client2.requests if request[0] == PAY_RUNS]
        self.assertEqual(len(list_calls), 1)
        self.assertEqual(list_calls[0][2]["if-modified-since"], http_date(NOW))
        self.assertEqual(client2.paths(PAY_RUNS + "/"), [f"{PAY_RUNS}/{B}", f"{PAY_RUNS}/{C}"])
        self.assertEqual(client2.paths(PAYSLIP + "/"), [f"{PAYSLIP}/slip-b1", f"{PAYSLIP}/slip-c1"])
        self.assertEqual({row["pay_run_id"] for row in emitted2["xero_payroll_au_payslips"]}, {B, C})
        b1_rows = [row for row in emitted2["xero_payroll_au_payslips"] if row["source_record_id"] == "slip-b1"]
        self.assertEqual(b1_rows[0]["wages"], "1600.00000000")
        self.assertEqual(sync2.state["fanouts"]["xero_payroll_au_payslips"],
                         {"watermark": later.isoformat(), "chain": CHAIN_VERSION})

        # Nothing changed since: one 304 on the list, no detail calls at all.
        client3 = ScriptedXero(routes)
        sync3, emitted3, _ = make_sync(client3, state=json.loads(json.dumps(sync2.state)), now=later + timedelta(days=1))
        sync3.sync_fan_out(FAN_OUT)
        self.assertEqual([request[0] for request in client3.requests], [PAY_RUNS])
        self.assertNotIn("xero_payroll_au_payslips", emitted3)

    def test_reserve_cut_resumes_without_respending(self):
        """A pass the daily reserve cuts short keeps the runs it landed in
        state; the next sync re-walks the list (cheap) and fetches only the
        rest, then completes the pass."""
        client = ScriptedXero(first_pass_routes(), budget=4)  # list, A's detail, A's two payslips; B's detail trips it
        sync, emitted, checkpoints = make_sync(client)
        with self.assertRaises(DailyLimitReached):
            sync.sync_fan_out(FAN_OUT)
        entry = sync.state["fanouts"]["xero_payroll_au_payslips"]
        self.assertEqual(set(entry["landed"]), {A})
        self.assertNotIn("chain", entry)
        self.assertNotIn("watermark", entry)
        self.assertEqual({row["pay_run_id"] for row in emitted["xero_payroll_au_payslips"]}, {A})

        client2 = ScriptedXero(first_pass_routes())
        resumed_at = NOW + timedelta(days=1)
        sync2, emitted2, _ = make_sync(client2, state=json.loads(json.dumps(sync.state)), now=resumed_at)
        sync2.sync_fan_out(FAN_OUT)
        list_calls = [request for request in client2.requests if request[0] == PAY_RUNS]
        self.assertNotIn("if-modified-since", list_calls[0][2])  # incomplete pass: full list, landed runs skipped
        self.assertEqual(client2.paths(PAY_RUNS + "/"), [f"{PAY_RUNS}/{B}"])
        self.assertEqual(client2.paths(PAYSLIP + "/"), [f"{PAYSLIP}/slip-b1"])
        self.assertEqual({row["pay_run_id"] for row in emitted2["xero_payroll_au_payslips"]}, {B})
        self.assertEqual(sync2.chain_stats["xero_payroll_au_payslips"]["already_landed"], 1)
        self.assertEqual(sync2.state["fanouts"]["xero_payroll_au_payslips"],
                         {"watermark": resumed_at.isoformat(), "chain": CHAIN_VERSION})

    def test_watermark_from_before_the_chain_is_ignored_once(self):
        """The pre-fix fan-out 'completed' every sync without landing a
        payslip, so production state carries a watermark; the first chained
        pass must backfill every pay run rather than honour it."""
        state = {"fanouts": {"xero_payroll_au_payslips": {"watermark": "2026-08-31T08:00:00+00:00"}}}
        client = ScriptedXero(first_pass_routes())
        sync, _emitted, _ = make_sync(client, state=state)
        sync.sync_fan_out(FAN_OUT)
        list_calls = [request for request in client.requests if request[0] == PAY_RUNS]
        self.assertNotIn("if-modified-since", list_calls[0][2])
        self.assertEqual(client.paths(PAY_RUNS + "/"), [f"{PAY_RUNS}/{A}", f"{PAY_RUNS}/{B}"])
        self.assertEqual(sync.state["fanouts"]["xero_payroll_au_payslips"],
                         {"watermark": NOW.isoformat(), "chain": CHAIN_VERSION})

    def test_unreadable_payslip_detail_still_lands_summaries(self):
        """A grant that cannot read Payslip/{id}: the summaries from the pay
        run detail land, probing stops after CHAIN_UNAVAILABLE_PROBES, the
        pass completes."""
        routes = first_pass_routes()
        denied = [path for path in routes if path.startswith(PAYSLIP + "/")]
        client = ScriptedXero(routes, unavailable=denied)
        sync, emitted, _ = make_sync(client)
        sync.sync_fan_out(FAN_OUT)
        self.assertEqual(len(client.paths(PAYSLIP + "/")), min(len(denied), CHAIN_UNAVAILABLE_PROBES))
        self.assertEqual({row["source_record_id"] for row in emitted["xero_payroll_au_payslips"]},
                         {"slip-a1", "slip-a2", "slip-b1"})
        self.assertNotIn("xero_payroll_au_payslip_earnings_lines", emitted)
        self.assertTrue(sync.chain_stats["xero_payroll_au_payslips"]["stubs_unavailable"])
        self.assertEqual(sync.state["fanouts"]["xero_payroll_au_payslips"]["chain"], CHAIN_VERSION)

    def test_unreachable_pay_run_detail_backs_off_like_a_group(self):
        """PayRuns/{id} refused for every run: the chain records itself
        unavailable (daily re-probe) after CHAIN_UNAVAILABLE_PROBES and
        remembers nothing as landed, so the backfill happens once it can."""
        routes = first_pass_routes()
        routes[PAY_RUNS] = {"PayRuns": [pay_run(A), pay_run(B), pay_run(C)]}
        client = ScriptedXero(routes, unavailable=[f"{PAY_RUNS}/{run}" for run in (A, B, C)])
        sync, emitted, _ = make_sync(client)
        sync.sync_fan_out(FAN_OUT)
        entry = sync.state["fanouts"]["xero_payroll_au_payslips"]
        self.assertIn("unavailable", entry)
        self.assertIn("retry_after", entry)
        self.assertEqual(entry.get("landed"), {})
        self.assertEqual(len(client.paths(PAY_RUNS + "/")), CHAIN_UNAVAILABLE_PROBES)
        self.assertNotIn("xero_payroll_au_payslips", emitted)

    def test_run_walks_the_chain_after_every_other_fan_out(self):
        """The chain is the costliest walk; run() defers it past every other
        group and fan-out so a reserve cut leaves the rest of the tables
        current, and reports its spend in the summary."""
        routes = first_pass_routes()
        employee = {"EmployeeID": "emp-ada", "FirstName": "Ada", "LastName": "Lovelace", "Status": "ACTIVE",
                    "UpdatedDateUTC": STAMP_1}
        routes["/payroll.xro/1.0/Employees"] = {"Employees": [employee]}
        routes["/payroll.xro/1.0/Employees/emp-ada"] = {"Employees": [{**employee, "HomeAddress": {
            "AddressLine1": "1 Test St", "City": "Ashburton", "Region": "VIC", "PostalCode": "3147"}}]}
        client = ScriptedXero(routes)
        sync, _emitted, _ = make_sync(client)
        summary_ = sync.run()
        paths = [request[0] for request in client.requests]
        first_detail = paths.index(f"{PAY_RUNS}/{A}")
        self.assertGreater(first_detail, paths.index("/payroll.xro/1.0/Employees/emp-ada"))
        self.assertGreater(first_detail, max(index for index, path in enumerate(paths)
                                             if path.startswith("/projects.xro/") or path.startswith("/api.xro/")))
        self.assertIsNone(summary_["stopped_early"])
        self.assertEqual(summary_["chains"]["xero_payroll_au_payslips"]["parent_calls"], 2)


if __name__ == "__main__":
    unittest.main()
